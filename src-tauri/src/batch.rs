//! The `batch` tool: many tool calls in one request, read inline or from a JSON file, with labels
//! and references between the calls so that a client never has to copy ids by hand.
//!
//! Everything here works against the `Frontend` trait, so it is tested without the app.

use std::collections::HashMap;
use std::path::Path;

use serde_json::{Map, Value, json};

use crate::bridge::Frontend;
use crate::files;
use crate::tools::{self, Image, ToolOutput, short};

/// Most commands one batch may contain.
pub const MAX_COMMANDS: usize = 20_000;
/// Largest commands file that is read.
pub const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
/// Deepest nesting of arrays and objects inside the params of a command.
const MAX_DEPTH: usize = 64;
/// Longest reference string and most path segments in one.
const MAX_REFERENCE_LENGTH: usize = 512;
const MAX_LABEL_LENGTH: usize = 64;
/// Errors beyond this many are counted instead of listed.
const MAX_REPORTED_ERRORS: usize = 100;
/// What a reference is replaced by when params are only validated.
const PLACEHOLDER: &str = "reference";
const VALIDATE_TOOL: &str = "app_validate_commands";

const OPTIONS: [&str; 6] = ["commands", "file", "resultMode", "continueOnError", "validateOnly", "documentId"];
/// Fields of a result that identify what a command made or touched (`resultMode: "ids"`).
const ID_FIELDS: [&str; 10] =
  ["id", "name", "ids", "objectId", "objectIds", "groupId", "materialId", "textureId", "layerId", "modifierId"];
/// Lists that are reduced to `{ id, name }` per entry in `resultMode: "ids"`.
const ID_LISTS: [&str; 4] = ["objects", "groups", "materials", "textures"];

#[derive(Debug, Clone, Copy, PartialEq)]
enum ResultMode {
  Full,
  Ids,
  Summary,
}

impl ResultMode {
  fn name(self) -> &'static str {
    match self {
      Self::Full => "full",
      Self::Ids => "ids",
      Self::Summary => "summary",
    }
  }
}

struct Options {
  mode: ResultMode,
  continue_on_error: bool,
  validate_only: bool,
  document_id: Option<String>,
}

enum Source {
  Inline(Vec<Value>),
  File(String),
}

struct Command {
  tool: String,
  params: Map<String, Value>,
  label: Option<String>,
}

/// Something wrong with the batch or with one of its commands.
struct Problem {
  index: Option<usize>,
  tool: Option<String>,
  label: Option<String>,
  message: String,
}

impl Problem {
  fn to_json(&self) -> Value {
    let mut entry = Map::new();
    if let Some(index) = self.index {
      entry.insert("index".into(), json!(index));
    }
    if let Some(tool) = &self.tool {
      entry.insert("tool".into(), json!(tool));
    }
    if let Some(label) = &self.label {
      entry.insert("as".into(), json!(label));
    }
    entry.insert("message".into(), json!(self.message));
    Value::Object(entry)
  }
}

/// Adds `errors` (at most `MAX_REPORTED_ERRORS`) and, if some were left out, `errorsOmitted`.
fn insert_errors(target: &mut Map<String, Value>, key: &str, problems: &[Problem]) {
  let listed: Vec<Value> = problems.iter().take(MAX_REPORTED_ERRORS).map(Problem::to_json).collect();
  target.insert(key.into(), Value::Array(listed));
  if problems.len() > MAX_REPORTED_ERRORS {
    target.insert(format!("{key}Omitted"), json!(problems.len() - MAX_REPORTED_ERRORS));
  }
}

fn type_name(value: &Value) -> &'static str {
  match value {
    Value::Null => "null",
    Value::Bool(_) => "a boolean",
    Value::Number(_) => "a number",
    Value::String(_) => "a string",
    Value::Array(_) => "an array",
    Value::Object(_) => "an object",
  }
}

// ---- arguments and the commands file ---------------------------------------------------------

fn parse_args(args: Value) -> Result<(Options, Source), String> {
  let Value::Object(mut args) = args else {
    return Err("The arguments of batch must be an object { commands | file, ... }".into());
  };
  if let Some(key) = args.keys().find(|key| !OPTIONS.contains(&key.as_str())) {
    return Err(format!("Unknown batch option \"{}\". Options: {}.", short(key), OPTIONS.join(", ")));
  }
  let mut take = |key: &str| args.remove(key).filter(|value| !value.is_null());

  let flag = |key: &str, value: Option<Value>| match value {
    None => Ok(false),
    Some(Value::Bool(flag)) => Ok(flag),
    Some(_) => Err(format!("\"{key}\" must be true or false")),
  };
  let continue_on_error = flag("continueOnError", take("continueOnError"))?;
  let validate_only = flag("validateOnly", take("validateOnly"))?;
  let document_id = match take("documentId") {
    None => None,
    Some(Value::String(id)) if !id.trim().is_empty() => Some(id),
    Some(_) => return Err("\"documentId\" must be the id of an open document (see document_list)".into()),
  };
  let mode = match take("resultMode") {
    None => None,
    Some(Value::String(mode)) => Some(match mode.as_str() {
      "full" => ResultMode::Full,
      "ids" => ResultMode::Ids,
      "summary" => ResultMode::Summary,
      _ => return Err(format!("Unknown resultMode \"{}\". Use \"full\", \"ids\" or \"summary\".", short(&mode))),
    }),
    Some(_) => return Err("\"resultMode\" must be \"full\", \"ids\" or \"summary\"".into()),
  };

  let source = match (take("commands"), take("file")) {
    (Some(_), Some(_)) => return Err("Pass either \"commands\" or \"file\", not both".into()),
    (None, None) => {
      return Err(
        "Pass \"commands\" (an array of { tool, params, as }) or \"file\" (absolute path of a .json file with that array)"
          .into(),
      );
    }
    (Some(Value::Array(commands)), None) => Source::Inline(commands),
    (Some(other), None) => {
      return Err(format!("\"commands\" must be an array of {{ tool, params, as }}, not {}", type_name(&other)));
    }
    (None, Some(Value::String(path))) if !path.trim().is_empty() => Source::File(path.trim().to_string()),
    (None, Some(_)) => return Err("\"file\" must be the absolute path of a .json file".into()),
  };
  // A file is run for its effect, so only what identifies the results comes back by default.
  let default_mode = if matches!(source, Source::File(_)) { ResultMode::Ids } else { ResultMode::Full };
  Ok((Options { mode: mode.unwrap_or(default_mode), continue_on_error, validate_only, document_id }, source))
}

/// Reads the commands array from a JSON file: either the array itself or `{ "commands": [...] }`.
async fn load_file(path: &str) -> Result<Vec<Value>, String> {
  let shown = short(path);
  if !Path::new(path).is_absolute() {
    return Err(format!("\"{shown}\" is not an absolute path. Pass a full path such as C:\\Models\\build.json."));
  }
  if files::extension(path) != "json" {
    return Err(format!("\"{shown}\" is not a commands file: the path must end in .json"));
  }
  let bytes = files::read_bytes_capped(path, MAX_FILE_BYTES, "run as a batch").await?;
  let text = files::decode_text(&bytes).map_err(|problem| format!("\"{shown}\" cannot be read as JSON: {problem}"))?;
  if text.trim().is_empty() {
    return Err(format!("\"{shown}\" is empty"));
  }
  let value: Value = serde_json::from_str(&text).map_err(|e| format!("\"{shown}\" is not valid JSON: {e}"))?;
  let wrong_shape = |found: &Value| {
    format!(
      "\"{shown}\" must contain a JSON array of commands [{{ \"tool\": ..., \"params\": ..., \"as\": ... }}] or an \
       object {{ \"commands\": [...] }}; found {}",
      type_name(found)
    )
  };
  match value {
    Value::Array(commands) => Ok(commands),
    Value::Object(mut object) => match object.remove("commands") {
      Some(Value::Array(commands)) => Ok(commands),
      Some(other) => Err(format!("\"commands\" in \"{shown}\" must be an array, not {}", type_name(&other))),
      None => Err(format!("{} without \"commands\"", wrong_shape(&Value::Object(object)))),
    },
    other => Err(wrong_shape(&other)),
  }
}

// ---- references ------------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
enum Target<'a> {
  Label(&'a str),
  Index(usize),
  Prev,
}

#[derive(Debug, PartialEq)]
enum Parsed<'a> {
  /// An ordinary string.
  Literal,
  /// `$$...`: the string without its first `$`.
  Escaped(&'a str),
  Reference { target: Target<'a>, path: Vec<&'a str> },
}

fn is_label_char(c: char) -> bool {
  c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// Reads a string value of a command's params. Every string starting with `$` must be a reference
/// (or escaped with `$$`), so that a typo never ends up as text in the scene.
fn parse_reference(text: &str) -> Result<Parsed<'_>, String> {
  let Some(body) = text.strip_prefix('$') else {
    return Ok(Parsed::Literal);
  };
  if body.starts_with('$') {
    return Ok(Parsed::Escaped(body));
  }
  let invalid = || {
    format!(
      "\"{}\" is not a valid reference. A reference is \"$label\", \"$label.path.to.field\", \"$<index>\" or \
       \"$prev\"; write \"$$\" to start a literal string with $",
      short(text)
    )
  };
  if text.len() > MAX_REFERENCE_LENGTH {
    return Err(invalid());
  }
  let mut parts = body.split('.');
  let name = parts.next().unwrap_or_default();
  let path: Vec<&str> = parts.collect();
  if name.is_empty() || !name.chars().all(is_label_char) || path.iter().any(|segment| segment.is_empty()) {
    return Err(invalid());
  }
  let target = if name == "prev" {
    Target::Prev
  } else if name.bytes().all(|b| b.is_ascii_digit()) {
    Target::Index(name.parse().map_err(|_| invalid())?)
  } else {
    Target::Label(name)
  };
  Ok(Parsed::Reference { target, path })
}

fn check_label(label: &str) -> Result<(), String> {
  let shown = short(label);
  if label.is_empty() || label.len() > MAX_LABEL_LENGTH || !label.chars().all(is_label_char) {
    Err(format!(
      "the label \"{shown}\" is not valid: use 1 to {MAX_LABEL_LENGTH} letters, digits, \"_\" or \"-\""
    ))
  } else if label == "prev" || label.bytes().all(|b| b.is_ascii_digit()) {
    Err(format!(
      "the label \"{shown}\" is reserved: \"$prev\" and \"$<number>\" already refer to commands by position"
    ))
  } else {
    Ok(())
  }
}

/// Index of the command a reference in command `index` points to, which must be an earlier one.
fn target_index(target: &Target, index: usize, total: usize, labels: &HashMap<String, usize>) -> Result<usize, String> {
  let found = match target {
    Target::Prev => match index.checked_sub(1) {
      Some(previous) => return Ok(previous),
      None => return Err("there is no previous command: this is the first one".into()),
    },
    Target::Index(position) if *position >= total => {
      return Err(format!(
        "there is no command {position}: the batch has {total} commands (indices start at 0)"
      ));
    }
    Target::Index(position) => *position,
    Target::Label(label) => match labels.get(*label) {
      Some(position) => *position,
      None => {
        let mut known: Vec<&str> = labels.keys().map(String::as_str).collect();
        known.sort_unstable();
        let known = match known.len() {
          0 => "no command has a label (\"as\")".to_string(),
          1..=12 => format!("labels are: {}", known.join(", ")),
          count => format!("labels are: {}, ... ({count} in total)", known[..12].join(", ")),
        };
        return Err(format!("there is no label \"{label}\"; {known}"));
      }
    },
  };
  if found == index {
    Err("it refers to this command itself; a reference can only use the result of an earlier command".into())
  } else if found > index {
    Err(format!(
      "it refers to command {found}, which runs later; a reference can only use the result of an earlier command"
    ))
  } else {
    Ok(found)
  }
}

/// Calls `visit` for every string value inside `value`, however deeply nested.
fn visit_strings(value: &Value, depth: usize, visit: &mut dyn FnMut(&str) -> Result<(), String>) -> Result<(), String> {
  if depth > MAX_DEPTH {
    return Err(format!("the params are nested deeper than {MAX_DEPTH} levels"));
  }
  match value {
    Value::String(text) => visit(text),
    Value::Array(items) => items.iter().try_for_each(|item| visit_strings(item, depth + 1, visit)),
    Value::Object(fields) => fields.values().try_for_each(|item| visit_strings(item, depth + 1, visit)),
    _ => Ok(()),
  }
}

/// Replaces every string value inside `value` for which `replace` returns a value.
fn substitute(
  value: &mut Value,
  depth: usize,
  replace: &mut dyn FnMut(&str) -> Result<Option<Value>, String>,
) -> Result<(), String> {
  if depth > MAX_DEPTH {
    return Err(format!("the params are nested deeper than {MAX_DEPTH} levels"));
  }
  match value {
    Value::String(text) => {
      if let Some(replacement) = replace(text)? {
        *value = replacement;
      }
      Ok(())
    }
    Value::Array(items) => items.iter_mut().try_for_each(|item| substitute(item, depth + 1, replace)),
    Value::Object(fields) => fields.values_mut().try_for_each(|item| substitute(item, depth + 1, replace)),
    _ => Ok(()),
  }
}

fn field_names(fields: &Map<String, Value>) -> String {
  if fields.is_empty() {
    return "it has no fields".into();
  }
  let names: Vec<String> = fields.keys().take(12).map(|key| short(key)).collect();
  let more = if fields.len() > 12 { ", ..." } else { "" };
  format!("it has: {}{more}", names.join(", "))
}

/// Reads what a reference points to out of the result of an earlier command.
fn read_path(result: &Value, path: &[&str], source: &str) -> Result<Value, String> {
  if path.is_empty() {
    return match result {
      Value::Object(fields) => match fields.get("id") {
        Some(id) if !id.is_null() => Ok(id.clone()),
        _ => Err(format!("the result of {source} has no \"id\" ({})", field_names(fields))),
      },
      other => Err(format!("the result of {source} is {}, so it has no \"id\"", type_name(other))),
    };
  }
  let mut current = result;
  for (position, segment) in path.iter().enumerate() {
    let at = if position == 0 { "the result".to_string() } else { format!("\"{}\"", path[..position].join(".")) };
    current = match current {
      Value::Object(fields) => fields
        .get(*segment)
        .ok_or_else(|| format!("{at} of {source} has no field \"{segment}\" ({})", field_names(fields)))?,
      Value::Array(items) => {
        let index: usize = segment
          .parse()
          .map_err(|_| format!("{at} of {source} is an array, so \"{segment}\" must be a number (0-based index)"))?;
        items
          .get(index)
          .ok_or_else(|| format!("{at} of {source} has {} items, so there is no index {index}", items.len()))?
      }
      other => {
        return Err(format!("{at} of {source} is {}, so \"{segment}\" cannot be read from it", type_name(other)));
      }
    };
  }
  Ok(current.clone())
}

// ---- checking a batch before it runs ---------------------------------------------------------

/// "Command 5 (scene_transform, as "leg")"
fn describe(index: usize, tool: &str, label: Option<&str>) -> String {
  match label {
    Some(label) => format!("command {index} ({}, as \"{label}\")", short(tool)),
    None => format!("command {index} ({})", short(tool)),
  }
}

fn capitalized(text: String) -> String {
  let mut chars = text.chars();
  match chars.next() {
    Some(first) => first.to_uppercase().chain(chars).collect(),
    None => text,
  }
}

struct Checked {
  /// One entry per command of the batch; None where the command has a problem.
  commands: Vec<Option<Command>>,
  labels: HashMap<String, usize>,
  problems: Vec<Problem>,
}

/// Checks everything that can be checked without running anything: the shape of every command,
/// that its tool exists (`tool_problem`), labels, and the syntax and order of references.
fn check_commands(raw: Vec<Value>, tool_problem: &dyn Fn(&str) -> Option<String>) -> Checked {
  let total = raw.len();
  let mut labels: HashMap<String, usize> = HashMap::new();
  let mut problems = Vec::new();

  let mut commands: Vec<Option<Command>> = raw
    .into_iter()
    .enumerate()
    .map(|(index, entry)| match parse_command(index, entry, &mut labels, tool_problem) {
      Ok(command) => Some(command),
      Err(problem) => {
        problems.push(problem);
        None
      }
    })
    .collect();

  // References need every label, so they are checked once all commands are read.
  for (index, slot) in commands.iter_mut().enumerate() {
    let Some(command) = slot else { continue };
    let mut check = |text: &str| match parse_reference(text)? {
      Parsed::Reference { target, .. } => target_index(&target, index, total, &labels)
        .map(drop)
        .map_err(|reason| format!("reference \"{}\": {reason}", short(text))),
      _ => Ok(()),
    };
    let checked = command.params.values().try_for_each(|value| visit_strings(value, 1, &mut check));
    if let Err(reason) = checked {
      let message = format!("{}: {reason}", capitalized(describe(index, &command.tool, command.label.as_deref())));
      problems.push(Problem { index: Some(index), tool: Some(command.tool.clone()), label: command.label.clone(), message });
      *slot = None;
    }
  }
  problems.sort_by_key(|problem| problem.index);
  Checked { commands, labels, problems }
}

fn parse_command(
  index: usize,
  entry: Value,
  labels: &mut HashMap<String, usize>,
  tool_problem: &dyn Fn(&str) -> Option<String>,
) -> Result<Command, Problem> {
  let problem = |tool: Option<&str>, label: Option<&str>, message: String| Problem {
    index: Some(index),
    tool: tool.map(short),
    label: label.map(short),
    message: format!("Command {index}: {message}"),
  };
  let Value::Object(mut entry) = entry else {
    return Err(problem(
      None,
      None,
      format!("must be an object {{ \"tool\": ..., \"params\": ..., \"as\": ... }}, not {}", type_name(&entry)),
    ));
  };
  let tool = match entry.remove("tool") {
    Some(Value::String(tool)) if !tool.trim().is_empty() => tool.trim().to_string(),
    Some(Value::String(_)) | None => return Err(problem(None, None, "needs a \"tool\" name".into())),
    Some(other) => return Err(problem(None, None, format!("\"tool\" must be a tool name, not {}", type_name(&other)))),
  };
  let label = match entry.remove("as") {
    None | Some(Value::Null) => None,
    Some(Value::String(label)) => Some(label),
    Some(other) => {
      return Err(problem(Some(&tool), None, format!("\"as\" must be a label string, not {}", type_name(&other))));
    }
  };
  let params = match entry.remove("params") {
    None | Some(Value::Null) => Map::new(),
    Some(Value::Object(params)) => params,
    Some(other) => {
      return Err(problem(Some(&tool), label.as_deref(), format!("\"params\" must be an object, not {}", type_name(&other))));
    }
  };
  if let Some(key) = entry.keys().next() {
    return Err(problem(
      Some(&tool),
      label.as_deref(),
      format!("unknown field \"{}\"; a command has \"tool\", \"params\" and \"as\"", short(key)),
    ));
  }
  if let Some(label) = &label {
    check_label(label).map_err(|reason| problem(Some(&tool), None, reason))?;
    if let Some(first) = labels.get(label) {
      return Err(problem(
        Some(&tool),
        Some(label),
        format!("the label \"{label}\" is already used by command {first}; labels must be unique"),
      ));
    }
    labels.insert(label.clone(), index);
  }
  if tool == "batch" {
    return Err(problem(Some(&tool), label.as_deref(), tools::NESTED_BATCH.into()));
  }
  if let Some(reason) = tool_problem(&tool) {
    return Err(problem(Some(&tool), label.as_deref(), reason));
  }
  Ok(Command { tool, params, label })
}

// ---- running ---------------------------------------------------------------------------------

/// The `batch` tool.
pub async fn run<F: Frontend>(frontend: &F, args: Value) -> ToolOutput {
  let (options, source) = match parse_args(args) {
    Ok(parsed) => parsed,
    Err(message) => return ToolOutput::error(message),
  };
  let loaded = match source {
    Source::Inline(commands) => Ok(commands),
    Source::File(path) => load_file(&path).await,
  };
  let raw = loaded.and_then(|commands| match commands.len() {
    0 => Err("The batch contains no commands".to_string()),
    count if count > MAX_COMMANDS => Err(format!(
      "The batch has {count} commands; the limit is {MAX_COMMANDS}. Split it into several batches."
    )),
    _ => Ok(commands),
  });
  let raw = match raw {
    Ok(raw) => raw,
    Err(message) if options.validate_only => {
      let value = json!({ "valid": false, "commands": 0, "errors": [{ "message": message }], "paramsValidated": false });
      return ToolOutput { value, is_error: true, images: Vec::new() };
    }
    Err(message) => return ToolOutput::error(message),
  };

  let total = raw.len();
  let tool_problem = |tool: &str| {
    let known = tools::is_native(tool) || frontend.command_id(tool).is_some();
    (!known).then(|| tools::unknown_tool(frontend, tool))
  };
  let checked = check_commands(raw, &tool_problem);

  if options.validate_only {
    return validate(frontend, total, checked).await;
  }
  if !checked.problems.is_empty() {
    let count = checked.problems.len();
    let mut value = Map::new();
    value.insert("executed".into(), json!(false));
    value.insert(
      "message".into(),
      json!(format!(
        "Nothing was executed: {count} of {total} commands have a problem that was found before running. Fix them and run the batch again."
      )),
    );
    value.insert("total".into(), json!(total));
    value.insert("completed".into(), json!(0));
    value.insert("failed".into(), json!(count));
    insert_errors(&mut value, "errors", &checked.problems);
    return ToolOutput { value: Value::Object(value), is_error: true, images: Vec::new() };
  }
  let commands: Vec<Command> = checked.commands.into_iter().flatten().collect();
  execute(frontend, &options, commands, &checked.labels).await
}

enum Slot {
  NotRun,
  Done(Value),
  Failed(String),
}

async fn execute<F: Frontend>(
  frontend: &F,
  options: &Options,
  mut commands: Vec<Command>,
  labels: &HashMap<String, usize>,
) -> ToolOutput {
  let total = commands.len();
  let mut slots: Vec<Slot> = Vec::with_capacity(total);
  // (command index, image), in order.
  let mut images: Vec<(usize, Image)> = Vec::new();
  let mut stopped_at = None;

  for index in 0..total {
    let mut params = Value::Object(std::mem::take(&mut commands[index].params));
    let resolved = {
      let mut resolve = |text: &str| match parse_reference(text)? {
        Parsed::Literal => Ok(None),
        Parsed::Escaped(literal) => Ok(Some(json!(literal))),
        Parsed::Reference { target, path } => lookup(&target, &path, index, &commands, labels, &slots)
          .map(Some)
          .map_err(|reason| format!("reference \"{}\": {reason}", short(text))),
      };
      substitute(&mut params, 0, &mut resolve)
    };
    let command = &commands[index];
    let outcome = match resolved {
      Err(reason) => Err(format!("{}: {reason}", capitalized(describe(index, &command.tool, command.label.as_deref())))),
      Ok(()) => {
        if let (Some(id), Some(params)) = (&options.document_id, params.as_object_mut()) {
          // A command may still name its own document.
          params.entry("documentId").or_insert_with(|| json!(id));
        }
        tools::call_single(frontend, &command.tool, params).await
      }
    };
    match outcome {
      Ok(mut result) => {
        if let Some(image) = tools::take_image(&mut result) {
          // A summary only shows the last picture.
          if options.mode == ResultMode::Summary {
            images.clear();
          }
          images.push((index, image));
        }
        slots.push(Slot::Done(result));
      }
      Err(message) => {
        slots.push(Slot::Failed(message));
        if !options.continue_on_error {
          stopped_at = Some(index);
          break;
        }
      }
    }
  }
  slots.resize_with(total, || Slot::NotRun);

  let mut errors = Vec::new();
  let mut completed = 0;
  for (index, slot) in slots.iter().enumerate() {
    match slot {
      Slot::Done(_) => completed += 1,
      Slot::Failed(message) => errors.push(Problem {
        index: Some(index),
        tool: Some(commands[index].tool.clone()),
        label: commands[index].label.clone(),
        message: message.clone(),
      }),
      Slot::NotRun => {}
    }
  }

  let mut value = Map::new();
  value.insert("resultMode".into(), json!(options.mode.name()));
  value.insert("total".into(), json!(total));
  value.insert("completed".into(), json!(completed));
  value.insert("failed".into(), json!(errors.len()));
  if let Some(index) = stopped_at.filter(|index| index + 1 < total) {
    value.insert("stoppedAt".into(), json!(index));
    value.insert("notExecuted".into(), json!(total - index - 1));
  }
  if !errors.is_empty() {
    insert_errors(&mut value, "errors", &errors);
  }

  let label_ids: Map<String, Value> = labels
    .iter()
    .map(|(label, index)| {
      let id = match &slots[*index] {
        Slot::Done(result) => result.get("id").cloned().unwrap_or(Value::Null),
        _ => Value::Null,
      };
      (label.clone(), id)
    })
    .collect();
  value.insert("labels".into(), Value::Object(label_ids));

  let image_number: HashMap<usize, usize> =
    images.iter().enumerate().map(|(position, (index, _))| (*index, position + 1)).collect();
  let image_note = |index: usize| image_number.get(&index).map(|number| json!(format!("returned as image content #{number}")));
  if options.mode != ResultMode::Summary {
    let mut results = Vec::new();
    for (index, (slot, command)) in slots.into_iter().zip(&commands).enumerate() {
      let mut entry = Map::new();
      entry.insert("index".into(), json!(index));
      if let Some(label) = &command.label {
        entry.insert("as".into(), json!(label));
      }
      match (slot, options.mode) {
        (Slot::NotRun, _) => continue,
        (Slot::Done(mut result), ResultMode::Full) => {
          if let (Some(note), Some(fields)) = (image_note(index), result.as_object_mut()) {
            fields.insert("image".into(), note);
          }
          entry.insert("tool".into(), json!(command.tool));
          entry.insert("result".into(), result);
        }
        (Slot::Failed(message), ResultMode::Full) => {
          entry.insert("tool".into(), json!(command.tool));
          entry.insert("error".into(), json!(message));
        }
        (Slot::Done(result), _) => {
          let mut identifying = identifying_fields(&result);
          if let Some(note) = image_note(index) {
            identifying.insert("image".into(), note);
          }
          // Commands that made nothing to refer to are only counted.
          if identifying.is_empty() {
            continue;
          }
          entry.insert("result".into(), Value::Object(identifying));
        }
        // In "ids" mode a failure is reported in `errors` only.
        (Slot::Failed(_), _) => continue,
      }
      results.push(Value::Object(entry));
    }
    value.insert("results".into(), Value::Array(results));
  }

  // What the document looks like now, so the client does not have to ask.
  match tools::document_info(frontend, options.document_id.as_deref()).await {
    Some(info) => {
      value.insert("objectCount".into(), info.object_count);
      value.insert("document".into(), json!({ "id": info.id, "name": info.name }));
    }
    None => {
      value.insert("objectCount".into(), Value::Null);
      value.insert("document".into(), Value::Null);
    }
  }

  ToolOutput {
    value: Value::Object(value),
    is_error: !errors.is_empty(),
    images: images.into_iter().map(|(_, image)| image).collect(),
  }
}

/// The value a reference stands for, from the result of an earlier command.
fn lookup(
  target: &Target,
  path: &[&str],
  index: usize,
  commands: &[Command],
  labels: &HashMap<String, usize>,
  slots: &[Slot],
) -> Result<Value, String> {
  let found = target_index(target, index, commands.len(), labels)?;
  let source = describe(found, &commands[found].tool, commands[found].label.as_deref());
  match slots.get(found) {
    Some(Slot::Done(result)) => read_path(result, path, &source),
    Some(Slot::Failed(_)) => Err(format!("{source} failed, so it has no result")),
    _ => Err(format!("{source} was not executed")),
  }
}

/// The fields of a result that say what was made or touched.
fn identifying_fields(result: &Value) -> Map<String, Value> {
  let mut kept = Map::new();
  let Some(fields) = result.as_object() else {
    return kept;
  };
  for key in ID_FIELDS {
    if let Some(value) = fields.get(key).filter(|value| !value.is_null()) {
      kept.insert(key.into(), value.clone());
    }
  }
  for key in ID_LISTS {
    let Some(items) = fields.get(key).and_then(Value::as_array) else { continue };
    let reduced: Vec<Value> = items
      .iter()
      .filter_map(|item| match item {
        Value::Object(item) => {
          let brief: Map<String, Value> =
            ["id", "name"].iter().filter_map(|k| item.get(*k).map(|v| (k.to_string(), v.clone()))).collect();
          (!brief.is_empty()).then_some(Value::Object(brief))
        }
        Value::String(_) | Value::Number(_) => Some(item.clone()),
        _ => None,
      })
      .collect();
    if !reduced.is_empty() {
      kept.insert(key.into(), Value::Array(reduced));
    }
  }
  kept
}

// ---- validateOnly ----------------------------------------------------------------------------

/// Runs nothing: reports the problems found by `check_commands` and has the params of every other
/// command validated - by the native tools' own checks and by the frontend's schemas.
async fn validate<F: Frontend>(frontend: &F, total: usize, checked: Checked) -> ToolOutput {
  let Checked { commands, mut problems, .. } = checked;
  // Problems with a command whose params contain a "$label.path" reference are only warnings: the
  // placeholder that stands in for the reference is a string, whatever the real value will be.
  let mut warnings = Vec::new();
  let mut frontend_commands = Vec::new();
  // Batch index and "has a path reference" for every entry of `frontend_commands`.
  let mut frontend_indices = Vec::new();
  let mut identities: Vec<(String, Option<String>)> = Vec::with_capacity(total);

  for (index, command) in commands.into_iter().enumerate() {
    let Some(Command { tool, params, label }) = command else {
      identities.push((String::new(), None));
      continue;
    };
    let mut params = Value::Object(params);
    let mut typed_reference = false;
    let mut placeholder = |text: &str| {
      Ok(match parse_reference(text)? {
        Parsed::Literal => None,
        Parsed::Escaped(literal) => Some(json!(literal)),
        Parsed::Reference { path, .. } => {
          typed_reference |= !path.is_empty();
          Some(json!(PLACEHOLDER))
        }
      })
    };
    // Cannot fail: check_commands has read every string already.
    let _ = substitute(&mut params, 0, &mut placeholder);

    if tools::is_native(&tool) {
      if let Err(message) = tools::check_native(&tool, &params) {
        let problem = Problem { index: Some(index), tool: Some(tool.clone()), label: label.clone(), message };
        if typed_reference { warnings.push(problem) } else { problems.push(problem) }
      }
    } else if let Some(command) = frontend.command_id(&tool) {
      frontend_commands.push(json!({ "command": command, "params": params }));
      frontend_indices.push((index, typed_reference));
    }
    identities.push((tool, label));
  }

  let mut note = None;
  let mut params_validated = false;
  if !frontend_commands.is_empty() {
    match frontend.command_id(VALIDATE_TOOL) {
      None => {
        note = Some(
          "The params of the commands were NOT validated against their schemas: this version of the editor has no \
           app_validate_commands. Shape, tool names, labels and references were checked."
            .to_string(),
        );
      }
      Some(command) => match frontend.call(&command, json!({ "commands": frontend_commands }), tools::FILE_TIMEOUT).await {
        Err(message) => {
          note = Some(format!(
            "The params of the commands were NOT validated against their schemas: {message}. Shape, tool names, \
             labels and references were checked."
          ));
        }
        Ok(report) => {
          params_validated = true;
          let reported = report.get("errors").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
          let mut understood = 0;
          for error in reported {
            let position = error.get("index").and_then(Value::as_u64).and_then(|i| usize::try_from(i).ok());
            let Some(&(index, typed_reference)) = position.and_then(|position| frontend_indices.get(position)) else {
              continue;
            };
            understood += 1;
            let (tool, label) = &identities[index];
            let message = match error.get("message") {
              Some(Value::String(message)) => message.clone(),
              Some(other) => other.to_string(),
              None => "invalid params".into(),
            };
            let problem = Problem { index: Some(index), tool: Some(tool.clone()), label: label.clone(), message };
            if typed_reference { warnings.push(problem) } else { problems.push(problem) }
          }
          if report.get("valid").and_then(Value::as_bool) == Some(false) && understood == 0 {
            problems.push(Problem {
              index: None,
              tool: None,
              label: None,
              message: "The editor reported invalid commands without saying which".into(),
            });
          }
        }
      },
    }
  } else {
    // Nothing for the frontend to look at.
    params_validated = true;
  }
  problems.sort_by_key(|problem| problem.index);
  warnings.sort_by_key(|problem| problem.index);

  let valid = problems.is_empty();
  let mut value = Map::new();
  value.insert("valid".into(), json!(valid));
  value.insert("commands".into(), json!(total));
  insert_errors(&mut value, "errors", &problems);
  if !warnings.is_empty() {
    insert_errors(&mut value, "warnings", &warnings);
    value.insert(
      "warningsNote".into(),
      json!("These commands take a value from a \"$label.path\" reference, which was checked as a placeholder string; the message may not apply to the real value."),
    );
  }
  value.insert("paramsValidated".into(), json!(params_validated));
  if let Some(note) = note {
    value.insert("note".into(), json!(note));
  }
  ToolOutput { value: Value::Object(value), is_error: !valid, images: Vec::new() }
}

#[cfg(test)]
#[path = "batch_tests.rs"]
mod tests;
