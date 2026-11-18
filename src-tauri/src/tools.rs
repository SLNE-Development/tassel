//! Tool dispatch: frontend commands plus the native tools that touch the file system.

use std::path::Path;

use serde_json::{Map, Value, json};

use crate::bridge::Bridge;
use crate::files;

pub struct NativeTool {
  pub name: &'static str,
  pub description: &'static str,
  pub input_schema: Value,
}

/// What a tool call produced. `is_error` results still carry a useful value (e.g. a partial batch).
pub struct ToolOutput {
  pub value: Value,
  pub is_error: bool,
}

const EXPORT_FORMATS: &str = ".glb (binary glTF, one self-contained file) and .gltf (glTF JSON with embedded buffers)";

pub fn native_tools() -> Vec<NativeTool> {
  vec![
    NativeTool {
      name: "file_save",
      description: "Save the active document as a Tessel project file (.tessel, JSON) on disk and mark it as saved. \
        Pass an absolute path ending in .tessel to save to a new location (\"save as\"); omit path to save to the \
        file the document was opened from or last saved to (see activeDocument.filePath in app_get_state). \
        Missing parent folders are created; an existing file is overwritten. The document is renamed to the file name.",
      input_schema: json!({
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Absolute path of the project file, ending in .tessel. Optional if the document already has a file path."
          }
        },
        "additionalProperties": false
      }),
    },
    NativeTool {
      name: "file_open",
      description: "Open a Tessel project file (.tessel) from disk in a new document tab and switch to it. \
        Returns the id and name of the new document. Other open documents are not affected.",
      input_schema: json!({
        "type": "object",
        "properties": {
          "path": { "type": "string", "description": "Absolute path of the project file, ending in .tessel." }
        },
        "required": ["path"],
        "additionalProperties": false
      }),
    },
    NativeTool {
      name: "file_export",
      description: "Export the active document to a glTF 2.0 file on disk for use in other tools and game engines. \
        The file extension chooses the format: .glb (binary, one self-contained file - usually what you want) or \
        .gltf (JSON text). Set selectionOnly to export just the selected objects. Missing parent folders are \
        created; an existing file is overwritten. This does not save the project - use file_save for that.",
      input_schema: json!({
        "type": "object",
        "properties": {
          "path": { "type": "string", "description": "Absolute path of the exported file, ending in .glb or .gltf." },
          "selectionOnly": {
            "type": "boolean",
            "default": false,
            "description": "Export only the selected objects instead of the whole document."
          }
        },
        "required": ["path"],
        "additionalProperties": false
      }),
    },
    NativeTool {
      name: "batch",
      description: "Run several tool calls in order with a single request, e.g. to build a scene from many \
        primitives and finish with view_screenshot. Execution stops at the first failing call; calls before it \
        stay applied (each is its own undo step). Returns the result of every executed call in order. \
        Any tool except batch itself can be used.",
      input_schema: json!({
        "type": "object",
        "properties": {
          "commands": {
            "type": "array",
            "minItems": 1,
            "description": "The tool calls to run, in order.",
            "items": {
              "type": "object",
              "properties": {
                "tool": { "type": "string", "description": "Tool name, e.g. scene_add_primitive." },
                "params": { "type": "object", "description": "Arguments of that tool. Defaults to {}." }
              },
              "required": ["tool"],
              "additionalProperties": false
            }
          }
        },
        "required": ["commands"],
        "additionalProperties": false
      }),
    },
  ]
}

/// Runs any tool by its MCP name.
pub async fn call(bridge: &Bridge, tool: &str, args: Value) -> ToolOutput {
  if tool == "batch" {
    return batch(bridge, &args).await;
  }
  match call_single(bridge, tool, args).await {
    Ok(value) => ToolOutput { value, is_error: false },
    Err(message) => ToolOutput { value: Value::String(message), is_error: true },
  }
}

async fn call_single(bridge: &Bridge, tool: &str, args: Value) -> Result<Value, String> {
  match tool {
    "file_save" => file_save(bridge, &args).await,
    "file_open" => file_open(bridge, &args).await,
    "file_export" => file_export(bridge, &args).await,
    "batch" => Err("batch cannot be nested inside batch".into()),
    _ => match bridge.find_command(tool) {
      Some(command) => bridge.call(&command.command_id(), args).await,
      None if bridge.commands().is_empty() => Err(format!(
        "Unknown tool \"{tool}\". The Tessel editor window has not registered its commands yet - try again in a moment."
      )),
      None => Err(format!("Unknown tool \"{tool}\". Use tools/list to see the available tools.")),
    },
  }
}

async fn batch(bridge: &Bridge, args: &Value) -> ToolOutput {
  let Some(commands) = args.get("commands").and_then(Value::as_array) else {
    return ToolOutput { value: Value::String("\"commands\" must be an array of { tool, params }".into()), is_error: true };
  };
  let total = commands.len();
  let mut results = Vec::with_capacity(total);
  let mut error = None;

  for (index, entry) in commands.iter().enumerate() {
    let tool = entry.get("tool").and_then(Value::as_str).unwrap_or_default();
    let outcome = if tool.is_empty() {
      Err("Each batch entry needs a \"tool\" name".to_string())
    } else {
      let params = entry.get("params").filter(|p| !p.is_null()).cloned().unwrap_or_else(|| json!({}));
      call_single(bridge, tool, params).await
    };
    match outcome {
      Ok(result) => results.push(json!({ "tool": tool, "result": result })),
      Err(message) => {
        error = Some(json!({ "index": index, "tool": tool, "message": message }));
        break;
      }
    }
  }

  let mut value = json!({ "completed": results.len(), "total": total, "results": results });
  let is_error = error.is_some();
  if let Some(error) = error {
    value["error"] = error;
  }
  ToolOutput { value, is_error }
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
  args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

fn require_absolute(path: &str) -> Result<(), String> {
  if Path::new(path).is_absolute() {
    Ok(())
  } else {
    Err(format!("\"{path}\" is not an absolute path. Pass a full path such as C:\\Models\\chair.tessel."))
  }
}

fn require_tessel(path: &str) -> Result<(), String> {
  require_absolute(path)?;
  if files::extension(path) == "tessel" {
    Ok(())
  } else {
    Err(format!("\"{path}\" is not a Tessel project file: the path must end in .tessel"))
  }
}

fn file_stem(path: &str) -> String {
  Path::new(path)
    .file_stem()
    .map(|s| s.to_string_lossy().into_owned())
    .unwrap_or_default()
}

fn field<'a>(value: &'a Value, key: &str, command: &str) -> Result<&'a str, String> {
  value
    .get(key)
    .and_then(Value::as_str)
    .ok_or_else(|| format!("The editor returned no \"{key}\" from {command}"))
}

async fn file_save(bridge: &Bridge, args: &Value) -> Result<Value, String> {
  // Validate an explicit path before bothering the frontend.
  if let Some(path) = str_arg(args, "path") {
    require_tessel(path)?;
  }
  let doc = bridge.call("document.serialize", json!({})).await?;
  let path = match str_arg(args, "path").or_else(|| doc.get("filePath").and_then(Value::as_str)) {
    Some(path) => path.to_string(),
    None => return Err("This document has never been saved, so a path is required: pass an absolute path ending in .tessel.".into()),
  };
  require_tessel(&path)?;

  let json = field(&doc, "json", "document.serialize")?;
  files::write_bytes(&path, json.as_bytes()).await?;

  let name = file_stem(&path);
  let mut mark = Map::new();
  if let Some(id) = doc.get("id").filter(|id| id.is_string()) {
    mark.insert("id".into(), id.clone());
  }
  mark.insert("filePath".into(), json!(path));
  mark.insert("name".into(), json!(name));
  bridge.call("document.mark_saved", Value::Object(mark)).await?;

  Ok(json!({ "saved": true, "path": path, "name": name, "bytes": json.len() }))
}

async fn file_open(bridge: &Bridge, args: &Value) -> Result<Value, String> {
  let path = str_arg(args, "path").ok_or("\"path\" is required")?;
  require_tessel(path)?;
  let json = files::read_text(path).await?;
  let opened = bridge
    .call("document.load", json!({ "json": json, "filePath": path, "name": file_stem(path) }))
    .await?;
  let mut result = json!({ "opened": true, "path": path });
  if let (Some(result), Some(opened)) = (result.as_object_mut(), opened.as_object()) {
    for (key, value) in opened {
      result.insert(key.clone(), value.clone());
    }
  }
  Ok(result)
}

async fn file_export(bridge: &Bridge, args: &Value) -> Result<Value, String> {
  let path = str_arg(args, "path").ok_or("\"path\" is required")?;
  require_absolute(path)?;
  let binary = match files::extension(path).as_str() {
    "glb" => true,
    "gltf" => false,
    "" => return Err(format!("\"{path}\" has no file extension. Supported export formats: {EXPORT_FORMATS}.")),
    other => return Err(format!("Cannot export to .{other}. Supported export formats: {EXPORT_FORMATS}.")),
  };
  let selection_only = args.get("selectionOnly").and_then(Value::as_bool).unwrap_or(false);

  let exported = bridge
    .call("export.gltf", json!({ "binary": binary, "selectionOnly": selection_only }))
    .await?;
  let bytes = if binary {
    files::decode_base64(field(&exported, "base64", "export.gltf")?)?
  } else {
    field(&exported, "text", "export.gltf")?.as_bytes().to_vec()
  };
  files::write_bytes(path, &bytes).await?;

  Ok(json!({
    "exported": true,
    "path": path,
    "format": if binary { "glb" } else { "gltf" },
    "bytes": bytes.len(),
    "selectionOnly": selection_only
  }))
}
