use serde_json::{Value, json};

use super::*;
use crate::testing::{Mock, TempDir, call, error_of};

fn batch(mock: &Mock, args: Value) -> ToolOutput {
  call(mock, "batch", args)
}

fn add(name: &str) -> Value {
  json!({ "tool": "scene_add_primitive", "params": { "type": "cube", "name": name } })
}

fn labelled(name: &str, label: &str) -> Value {
  json!({ "tool": "scene_add_primitive", "params": { "type": "cube", "name": name }, "as": label })
}

/// The message of the only error in a batch result.
fn only_error(output: &ToolOutput) -> String {
  assert!(output.is_error, "expected an error, got {}", output.value);
  let errors = output.value["errors"].as_array().unwrap_or_else(|| panic!("no errors in {}", output.value));
  assert_eq!(errors.len(), 1, "{}", output.value);
  errors[0]["message"].as_str().unwrap().to_string()
}

/// The params the editor received for the `nth` call of `command`.
fn params_of(mock: &Mock, command: &str, nth: usize) -> Value {
  mock.calls_of(command).get(nth).cloned().unwrap_or_else(|| panic!("no call {nth} of {command}"))
}

// ---- arguments -------------------------------------------------------------------------------

#[test]
fn exactly_one_of_commands_and_file() {
  let mock = Mock::new();
  assert!(error_of(&batch(&mock, json!({}))).contains("Pass \"commands\""));
  assert!(error_of(&batch(&mock, json!({ "commands": null, "file": null }))).contains("Pass \"commands\""));
  let both = batch(&mock, json!({ "commands": [add("a")], "file": "C:\\a.json" }));
  assert!(error_of(&both).contains("not both"));
  assert!(mock.calls().is_empty());
}

#[test]
fn options_are_checked() {
  let mock = Mock::new();
  let commands = json!([add("a")]);
  let cases = [
    (json!({ "commands": commands, "continueOnErrors": true }), "Unknown batch option \"continueOnErrors\""),
    (json!({ "commands": commands, "resultMode": "tiny" }), "Unknown resultMode \"tiny\""),
    (json!({ "commands": commands, "resultMode": 3 }), "\"resultMode\" must be"),
    (json!({ "commands": commands, "continueOnError": "yes" }), "\"continueOnError\" must be true or false"),
    (json!({ "commands": commands, "validateOnly": 1 }), "\"validateOnly\" must be true or false"),
    (json!({ "commands": commands, "documentId": 5 }), "\"documentId\" must be"),
    (json!({ "commands": commands, "documentId": " " }), "\"documentId\" must be"),
    (json!({ "commands": { "tool": "x" } }), "\"commands\" must be an array"),
    (json!({ "commands": "[]" }), "\"commands\" must be an array"),
    (json!({ "commands": [] }), "contains no commands"),
    (json!({ "file": 5 }), "\"file\" must be the absolute path"),
    (json!({ "file": "" }), "\"file\" must be the absolute path"),
    (json!("commands"), "must be an object"),
    (json!(null), "must be an object"),
  ];
  for (args, expected) in cases {
    let message = error_of(&batch(&mock, args.clone()));
    assert!(message.contains(expected), "{args}: {message}");
  }
  assert!(mock.calls().is_empty());
}

#[test]
fn too_many_commands_are_refused() {
  let mock = Mock::new();
  let commands: Vec<Value> = (0..=MAX_COMMANDS).map(|_| json!({ "tool": "scene_transform" })).collect();
  let message = error_of(&batch(&mock, json!({ "commands": commands })));
  assert!(message.contains("20001 commands") && message.contains("limit is 20000"), "{message}");
  assert!(mock.calls().is_empty());

  // The limit itself is fine.
  let commands: Vec<Value> = (0..MAX_COMMANDS).map(|_| json!({ "tool": "scene_transform" })).collect();
  let output = batch(&mock, json!({ "commands": commands, "resultMode": "summary" }));
  assert!(!output.is_error);
  assert_eq!(output.value["completed"], 20000);
}

// ---- the commands file -----------------------------------------------------------------------

#[test]
fn file_problems_are_named() {
  let mock = Mock::new();
  let dir = TempDir::new("batch-file-problems");
  let run = |path: &str| error_of(&batch(&mock, json!({ "file": path })));

  let missing = run(&dir.path("missing.json"));
  assert!(missing.contains("Could not read") && missing.contains("missing.json"), "{missing}");
  assert!(run("build.json").contains("not an absolute path"));
  assert!(run("..\\build.json").contains("not an absolute path"));
  assert!(run(&dir.file("build.txt", "[]")).contains("must end in .json"));
  assert!(run(&dir.file("build", "[]")).contains("must end in .json"));
  assert!(run(&dir.0.to_string_lossy()).contains("must end in .json"));
  std::fs::create_dir_all(dir.0.join("folder.json")).unwrap();
  assert!(run(&dir.path("folder.json")).contains("is not a file"));

  assert!(run(&dir.file("empty.json", "")).contains("is empty"));
  assert!(run(&dir.file("blank.json", " \n ")).contains("is empty"));
  let invalid = run(&dir.file("invalid.json", "[{ \"tool\": \"scene_transform\" },\n  oops]"));
  assert!(invalid.contains("is not valid JSON") && invalid.contains("line 2"), "{invalid}");
  assert!(run(&dir.file("binary.json", [0xc3u8, 0x28, 0xff])).contains("not valid UTF-8"));

  for (name, text, expected) in [
    ("string.json", "\"commands\"", "found a string"),
    ("number.json", "42", "found a number"),
    ("null.json", "null", "found null"),
    ("object.json", "{ \"tool\": \"scene_transform\" }", "without \"commands\""),
    ("nested.json", "{ \"commands\": { \"tool\": \"x\" } }", "must be an array, not an object"),
    ("none.json", "[]", "contains no commands"),
    ("none2.json", "{ \"commands\": [] }", "contains no commands"),
  ] {
    let message = run(&dir.file(name, text));
    assert!(message.contains(expected), "{name}: {message}");
  }

  // A wrong command inside the file is reported with its index, and nothing runs.
  let wrong = batch(&mock, json!({ "file": dir.file("wrong.json", "[{ \"tool\": \"scene_transform\" }, 7]") }));
  assert_eq!(wrong.value["executed"], false);
  assert_eq!(wrong.value["errors"][0]["index"], 1);
  assert!(only_error(&wrong).contains("Command 1: must be an object"));
  assert!(mock.calls().is_empty());
}

#[test]
fn too_large_files_are_refused_before_reading() {
  let mock = Mock::new();
  let dir = TempDir::new("batch-file-large");
  let path = dir.file("big.json", vec![b' '; MAX_FILE_BYTES as usize + 1]);
  let message = error_of(&batch(&mock, json!({ "file": path })));
  assert!(message.contains("too large to run as a batch") && message.contains("limit is 16 MB"), "{message}");
}

#[test]
fn files_run_as_array_or_object_and_default_to_ids() {
  let dir = TempDir::new("batch-file-run");
  let commands = json!([labelled("Seat", "seat"), { "tool": "scene_transform", "params": { "id": "$seat" } }]);
  let files = [
    dir.file("array.json", commands.to_string()),
    dir.file("object.json", json!({ "commands": commands, "comment": "ignored" }).to_string()),
    // What Windows PowerShell writes: UTF-8 with a byte order mark, or UTF-16.
    dir.file("bom.json", [&[0xef, 0xbb, 0xbf][..], commands.to_string().as_bytes()].concat()),
    dir.file("utf16.json", {
      let mut bytes = vec![0xff, 0xfe];
      bytes.extend(commands.to_string().encode_utf16().flat_map(u16::to_le_bytes));
      bytes
    }),
  ];
  for file in files {
    let mock = Mock::new();
    let output = batch(&mock, json!({ "file": file }));
    assert!(!output.is_error, "{file}: {}", output.value);
    assert_eq!(output.value["resultMode"], "ids");
    assert_eq!(output.value["completed"], 2);
    assert_eq!(output.value["labels"], json!({ "seat": "obj1" }));
    assert_eq!(params_of(&mock, "scene.transform", 0), json!({ "id": "obj1" }));
  }

  // An explicit mode wins over the default for files.
  let mock = Mock::new();
  let output = batch(&mock, json!({ "file": dir.file("full.json", commands.to_string()), "resultMode": "full" }));
  assert_eq!(output.value["results"][0]["result"]["vertexCount"], 8);
}

// ---- shape, labels, references (checked before anything runs) --------------------------------

#[test]
fn wrong_commands_execute_nothing() {
  let mock = Mock::new();
  let output = batch(
    &mock,
    json!({ "commands": [
      add("ok"),
      "scene_add_primitive",
      { "params": {} },
      { "tool": "" },
      { "tool": 5 },
      { "tool": "scene_transform", "params": [1, 2] },
      { "tool": "scene_transform", "args": {} },
      { "tool": "scene_transform", "as": 7 },
      { "tool": "scene_nope" },
      { "tool": "scene.add_primitive" },
      null
    ] }),
  );
  assert!(output.is_error);
  assert_eq!(output.value["executed"], false);
  assert_eq!(output.value["total"], 11);
  assert_eq!(output.value["failed"], 10);
  assert!(output.value["message"].as_str().unwrap().contains("Nothing was executed"));
  let errors = output.value["errors"].as_array().unwrap();
  let expected = [
    (1, "must be an object"),
    (2, "needs a \"tool\" name"),
    (3, "needs a \"tool\" name"),
    (4, "\"tool\" must be a tool name, not a number"),
    (5, "\"params\" must be an object, not an array"),
    (6, "unknown field \"args\""),
    (7, "\"as\" must be a label string"),
    (8, "Unknown tool \"scene_nope\""),
    (9, "Tool names use underscores, e.g. \"scene_add_primitive\""),
    (10, "must be an object"),
  ];
  assert_eq!(errors.len(), expected.len());
  for (error, (index, text)) in errors.iter().zip(expected) {
    assert_eq!(error["index"], index);
    let message = error["message"].as_str().unwrap();
    assert!(message.starts_with(&format!("Command {index}: ")) && message.contains(text), "{message}");
  }
  assert!(mock.calls().is_empty());
}

#[test]
fn nested_batch_is_rejected() {
  let mock = Mock::new();
  let output = batch(&mock, json!({ "commands": [add("a"), { "tool": "batch", "params": { "commands": [add("b")] } }] }));
  assert!(only_error(&output).contains("batch cannot be nested inside batch"));
  assert_eq!(output.value["errors"][0]["index"], 1);
  assert!(mock.calls().is_empty());
  // The dispatcher refuses it as well.
  let direct = crate::testing::block_on(tools::call_single(&mock, "batch", json!({})));
  assert_eq!(direct.unwrap_err(), "batch cannot be nested inside batch");
}

#[test]
fn an_editor_that_is_still_starting_is_reported() {
  let mock = Mock::starting();
  let output = batch(&mock, json!({ "commands": [add("a")] }));
  assert!(only_error(&output).contains("has not registered its commands yet"));
}

#[test]
fn label_syntax_and_duplicates() {
  let mock = Mock::new();
  for (label, expected) in [
    ("", "is not valid"),
    ("my leg", "is not valid"),
    ("leg.1", "is not valid"),
    ("$leg", "is not valid"),
    ("bein\u{e4}", "is not valid"),
    ("prev", "is reserved"),
    ("12", "is reserved"),
  ] {
    let message = only_error(&batch(&mock, json!({ "commands": [labelled("a", label)] })));
    assert!(message.contains(expected), "{label}: {message}");
  }
  let long = "x".repeat(65);
  assert!(only_error(&batch(&mock, json!({ "commands": [labelled("a", &long)] }))).contains("is not valid"));

  let duplicate = batch(&mock, json!({ "commands": [labelled("a", "leg"), add("b"), labelled("c", "leg")] }));
  assert_eq!(duplicate.value["errors"][0]["index"], 2);
  assert!(only_error(&duplicate).contains("the label \"leg\" is already used by command 0"));
  assert!(mock.calls().is_empty());

  // Everything the syntax allows, and "as": null means no label.
  let output = batch(
    &mock,
    json!({ "commands": [labelled("a", "Leg_1-b"), labelled("b", "9a"), { "tool": "scene_transform", "as": null }] }),
  );
  assert!(!output.is_error, "{}", output.value);
  assert_eq!(output.value["labels"], json!({ "Leg_1-b": "obj1", "9a": "obj2" }));
}

#[test]
fn every_reference_form_is_resolved() {
  let mock = Mock::new();
  let output = batch(
    &mock,
    json!({ "commands": [
      labelled("Seat", "seat"),
      { "tool": "group_create", "params": { "ids": ["$seat"] }, "as": "grp" },
      { "tool": "scene_transform", "params": {
        "id": "$seat",
        "byIndex": "$0",
        "byIndexPath": "$1.name",
        "previous": "$prev",
        "previousPath": "$prev.objects.1.id",
        "name": "$seat.name",
        "number": "$seat.vertexCount",
        "nested": { "list": ["$grp.objects.0.id", ["$grp", { "deep": "$grp.objects.1.visible" }]], "y": "$grp.bounds.max.1" },
        "whole": "$grp.objects",
        "object": "$grp.bounds",
        "escaped": "$$5 off",
        "escapedReference": "$$seat",
        "doubleEscaped": "$$$x",
        "plain": "costs 5$ and a$b",
        "untouched": [1, 2.5, true, null],
        "$seat": "keys are not references"
      } }
    ] }),
  );
  assert!(!output.is_error, "{}", output.value);
  assert_eq!(params_of(&mock, "group.create", 0), json!({ "ids": ["obj1"] }));
  assert_eq!(
    params_of(&mock, "scene.transform", 0),
    json!({
      "id": "obj1",
      "byIndex": "obj1",
      "byIndexPath": "Group",
      "previous": "grp2",
      "previousPath": "a2",
      "name": "Seat",
      "number": 8,
      "nested": { "list": ["a1", ["grp2", { "deep": false }]], "y": 2.5 },
      "whole": [{ "id": "a1", "name": "A", "visible": true }, { "id": "a2", "name": "B", "visible": false }],
      "object": { "min": [0, 0, 0], "max": [1, 2.5, 3] },
      "escaped": "$5 off",
      "escapedReference": "$seat",
      "doubleEscaped": "$$x",
      "plain": "costs 5$ and a$b",
      "untouched": [1, 2.5, true, null],
      "$seat": "keys are not references"
    })
  );
}

#[test]
fn malformed_references_are_errors() {
  let mock = Mock::new();
  for text in ["$", "$.id", "$seat.", "$seat..id", "$my label", "$seat/id", "${seat}", "$seat id", "$99999999999999999999999"] {
    let output = batch(&mock, json!({ "commands": [labelled("a", "seat"), { "tool": "scene_transform", "params": { "id": text } }] }));
    let message = only_error(&output);
    assert!(message.contains("is not a valid reference") && message.contains("write \"$$\""), "{text}: {message}");
    assert!(message.starts_with("Command 1 (scene_transform): "), "{message}");
  }
  let long = format!("$seat.{}", "a".repeat(600));
  let output = batch(&mock, json!({ "commands": [labelled("a", "seat"), { "tool": "scene_transform", "params": { "id": long } }] }));
  let message = only_error(&output);
  assert!(message.contains("is not a valid reference") && message.len() < 400, "{message}");
  assert!(mock.calls().is_empty());
}

#[test]
fn unknown_and_forward_references_are_found_before_running() {
  let mock = Mock::new();
  let transform = |reference: &str| json!({ "tool": "scene_transform", "params": { "ids": [reference] }, "as": "move" });
  let cases = [
    (json!([labelled("a", "seat"), transform("$sofa")]), 1, "reference \"$sofa\": there is no label \"sofa\"; labels are: move, seat"),
    (json!([transform("$seat"), labelled("a", "seat")]), 0, "it refers to command 1, which runs later"),
    (json!([add("a"), transform("$move.id")]), 1, "it refers to this command itself"),
    (json!([add("a"), transform("$1")]), 1, "it refers to this command itself"),
    (json!([transform("$1"), add("a")]), 0, "it refers to command 1, which runs later"),
    (json!([add("a"), transform("$7")]), 1, "there is no command 7: the batch has 2 commands"),
    (json!([transform("$prev"), add("a")]), 0, "there is no previous command"),
  ];
  for (commands, index, expected) in cases {
    let output = batch(&mock, json!({ "commands": commands }));
    assert_eq!(output.value["executed"], false, "{commands}");
    assert_eq!(output.value["errors"][0]["index"], index);
    assert_eq!(output.value["errors"][0]["tool"], "scene_transform");
    assert_eq!(output.value["errors"][0]["as"], "move");
    let message = only_error(&output);
    assert!(message.contains(expected), "{commands}: {message}");
    assert!(message.starts_with(&format!("Command {index} (scene_transform, as \"move\"): reference \"$")), "{message}");
  }
  let unlabelled = batch(&mock, json!({ "commands": [add("a"), { "tool": "scene_transform", "params": { "id": "$sofa" } }] }));
  assert!(only_error(&unlabelled).contains("there is no label \"sofa\"; no command has a label"));
  assert!(mock.calls().is_empty());
}

#[test]
fn missing_fields_fail_the_referencing_command() {
  let cases = [
    ("$move", "the result of command 1 (scene_transform, as \"move\") has no \"id\" (it has: moved)"),
    ("$nothing", "the result of command 2 (scene_null, as \"nothing\") is null, so it has no \"id\""),
    ("$nothing.x", "the result of command 2 (scene_null, as \"nothing\") is null, so \"x\" cannot be read"),
    ("$grp.colour", "has no field \"colour\" (it has: bounds, id, name, objects)"),
    ("$grp.objects.2.id", "\"objects\" of command 0 (group_create, as \"grp\") has 2 items, so there is no index 2"),
    ("$grp.objects.first", "is an array, so \"first\" must be a number"),
    ("$grp.objects.-1", "is an array, so \"-1\" must be a number"),
    ("$grp.name.length", "\"name\" of command 0 (group_create, as \"grp\") is a string, so \"length\" cannot be read"),
    ("$grp.objects.0.id.x", "\"objects.0.id\" of command 0"),
  ];
  for (reference, expected) in cases {
    let mock = Mock::new();
    let output = batch(
      &mock,
      json!({ "commands": [
        { "tool": "group_create", "as": "grp" },
        { "tool": "scene_transform", "as": "move" },
        { "tool": "scene_null", "as": "nothing" },
        { "tool": "scene_add_primitive", "params": { "parent": { "id": reference } }, "as": "leg" },
        add("never")
      ] }),
    );
    let message = only_error(&output);
    assert!(message.contains(expected), "{reference}: {message}");
    assert!(message.starts_with(&format!("Command 3 (scene_add_primitive, as \"leg\"): reference \"{reference}\": ")), "{message}");
    assert_eq!(output.value["errors"][0], json!({ "index": 3, "tool": "scene_add_primitive", "as": "leg", "message": message }));
    // The commands before it ran, the failing one and those after it did not.
    assert_eq!(mock.executed(), ["group.create", "scene.transform", "scene.null"]);
    assert_eq!(output.value["completed"], 3);
    assert_eq!(output.value["stoppedAt"], 3);
    assert_eq!(output.value["notExecuted"], 1);
  }
}

#[test]
fn deeply_nested_params_are_refused() {
  let mock = Mock::new();
  let nested = |depth: usize| (0..depth).fold(json!("$seat"), |inner, _| json!([inner]));
  let run = |depth: usize| batch(&mock, json!({ "commands": [labelled("a", "seat"), { "tool": "scene_transform", "params": { "v": nested(depth) } }] }));
  assert!(!run(60).is_error);
  assert!(only_error(&run(70)).contains("nested deeper than 64 levels"));
  assert!(only_error(&run(120)).contains("nested deeper than 64 levels"));
}

// ---- errors while running --------------------------------------------------------------------

#[test]
fn stops_at_the_first_error_by_default() {
  let mock = Mock::new();
  let output = batch(&mock, json!({ "commands": [labelled("a", "first"), { "tool": "scene_fail", "as": "bad" }, add("c"), add("d")] }));
  assert!(output.is_error);
  assert_eq!(mock.executed(), ["scene.add_primitive", "scene.fail"]);
  assert_eq!(output.value["total"], 4);
  assert_eq!(output.value["completed"], 1);
  assert_eq!(output.value["failed"], 1);
  assert_eq!(output.value["stoppedAt"], 1);
  assert_eq!(output.value["notExecuted"], 2);
  assert_eq!(output.value["errors"], json!([{ "index": 1, "tool": "scene_fail", "as": "bad", "message": "boom" }]));
  assert_eq!(output.value["labels"], json!({ "first": "obj1", "bad": null }));
  let results = output.value["results"].as_array().unwrap();
  assert_eq!(results.len(), 2);
  assert_eq!(results[1], json!({ "index": 1, "as": "bad", "tool": "scene_fail", "error": "boom" }));
  // The state of the document is still reported.
  assert_eq!(output.value["objectCount"], 7);

  // Failing at the very end leaves nothing unexecuted.
  let last = batch(&Mock::new(), json!({ "commands": [add("a"), { "tool": "scene_fail" }] }));
  assert!(last.value.get("stoppedAt").is_none() && last.value.get("notExecuted").is_none());
}

#[test]
fn continue_on_error_runs_everything_and_reports_all_errors() {
  let mock = Mock::new();
  let output = batch(
    &mock,
    json!({ "continueOnError": true, "commands": [
      { "tool": "scene_fail", "as": "bad" },
      labelled("a", "good"),
      { "tool": "scene_transform", "params": { "id": "$bad" }, "as": "usesBad" },
      { "tool": "scene_transform", "params": { "id": "$0.name" } },
      { "tool": "scene_transform", "params": { "id": "$usesBad" } },
      { "tool": "scene_transform", "params": { "id": "$good" } },
      { "tool": "scene_fail" }
    ] }),
  );
  assert!(output.is_error);
  assert_eq!(mock.executed(), ["scene.fail", "scene.add_primitive", "scene.transform", "scene.fail"]);
  assert_eq!(params_of(&mock, "scene.transform", 0), json!({ "id": "obj2" }));
  assert_eq!(output.value["total"], 7);
  assert_eq!(output.value["completed"], 2);
  assert_eq!(output.value["failed"], 5);
  assert!(output.value.get("stoppedAt").is_none());
  let errors = output.value["errors"].as_array().unwrap();
  let indices: Vec<u64> = errors.iter().map(|e| e["index"].as_u64().unwrap()).collect();
  assert_eq!(indices, [0, 2, 3, 4, 6]);
  assert_eq!(errors[0]["message"], "boom");
  assert_eq!(
    errors[1]["message"],
    "Command 2 (scene_transform, as \"usesBad\"): reference \"$bad\": command 0 (scene_fail, as \"bad\") failed, so it has no result"
  );
  assert_eq!(
    errors[2]["message"],
    "Command 3 (scene_transform): reference \"$0.name\": command 0 (scene_fail, as \"bad\") failed, so it has no result"
  );
  // A failure caused by a failed reference counts as failed for those who refer to it.
  assert!(errors[3]["message"].as_str().unwrap().contains("command 2 (scene_transform, as \"usesBad\") failed"));
  assert_eq!(output.value["labels"], json!({ "bad": null, "good": "obj2", "usesBad": null }));
}

#[test]
fn many_errors_are_counted_instead_of_listed() {
  let mock = Mock::new();
  let commands: Vec<Value> = (0..250).map(|_| json!({ "tool": "scene_fail" })).collect();
  let output = batch(&mock, json!({ "commands": commands, "continueOnError": true, "resultMode": "summary" }));
  assert_eq!(output.value["failed"], 250);
  assert_eq!(output.value["errors"].as_array().unwrap().len(), 100);
  assert_eq!(output.value["errorsOmitted"], 150);

  let broken: Vec<Value> = (0..250).map(|_| json!({ "tool": "nope" })).collect();
  let output = batch(&mock, json!({ "commands": broken }));
  assert_eq!(output.value["errors"].as_array().unwrap().len(), 100);
  assert_eq!(output.value["errorsOmitted"], 150);
}

// ---- result modes and images -----------------------------------------------------------------

fn scene() -> Value {
  json!([
    labelled("Seat", "seat"),
    { "tool": "view_screenshot", "as": "shot1" },
    { "tool": "scene_transform", "params": { "id": "$seat" } },
    { "tool": "group_create", "params": { "ids": ["$seat"] }, "as": "grp" },
    { "tool": "scene_null" },
    { "tool": "view_screenshot" }
  ])
}

#[test]
fn full_mode_returns_every_result() {
  let mock = Mock::new();
  let output = batch(&mock, json!({ "commands": scene() }));
  assert!(!output.is_error);
  assert_eq!(
    output.value,
    json!({
      "resultMode": "full",
      "total": 6,
      "completed": 6,
      "failed": 0,
      "labels": { "seat": "obj1", "shot1": null, "grp": "grp4" },
      "results": [
        { "index": 0, "as": "seat", "tool": "scene_add_primitive", "result": { "id": "obj1", "name": "Seat", "vertexCount": 8 } },
        { "index": 1, "as": "shot1", "tool": "view_screenshot", "result": { "width": 64, "image": "returned as image content #1" } },
        { "index": 2, "tool": "scene_transform", "result": { "moved": true } },
        { "index": 3, "as": "grp", "tool": "group_create", "result": {
          "id": "grp4",
          "name": "Group",
          "objects": [{ "id": "a1", "name": "A", "visible": true }, { "id": "a2", "name": "B", "visible": false }],
          "bounds": { "min": [0, 0, 0], "max": [1, 2.5, 3] }
        } },
        { "index": 4, "tool": "scene_null", "result": null },
        { "index": 5, "tool": "view_screenshot", "result": { "width": 64, "image": "returned as image content #2" } }
      ],
      "objectCount": 7,
      "document": { "id": "doc1", "name": "Model" }
    })
  );
  assert_eq!(output.images, [("IMG2".to_string(), "image/png".to_string()), ("IMG6".to_string(), "image/png".to_string())]);
}

#[test]
fn ids_mode_returns_only_identifying_fields() {
  let mock = Mock::new();
  let output = batch(&mock, json!({ "commands": scene(), "resultMode": "ids" }));
  assert!(!output.is_error);
  assert_eq!(
    output.value,
    json!({
      "resultMode": "ids",
      "total": 6,
      "completed": 6,
      "failed": 0,
      "labels": { "seat": "obj1", "shot1": null, "grp": "grp4" },
      "results": [
        { "index": 0, "as": "seat", "result": { "id": "obj1", "name": "Seat" } },
        { "index": 1, "as": "shot1", "result": { "image": "returned as image content #1" } },
        { "index": 3, "as": "grp", "result": {
          "id": "grp4",
          "name": "Group",
          "objects": [{ "id": "a1", "name": "A" }, { "id": "a2", "name": "B" }]
        } },
        { "index": 5, "result": { "image": "returned as image content #2" } }
      ],
      "objectCount": 7,
      "document": { "id": "doc1", "name": "Model" }
    })
  );
  assert_eq!(output.images.len(), 2);
}

#[test]
fn ids_mode_keeps_every_identifying_field() {
  let mock = Mock::with(|command, _| {
    (command == "scene.add_primitive").then(|| {
      Ok(json!({
        "id": "i", "name": "n", "ids": ["a", "b"], "objectId": "o", "objectIds": ["o1"], "groupId": "g",
        "materialId": "m", "textureId": "t", "layerId": "l", "modifierId": "mod",
        "objects": [{ "id": "o1", "name": "O", "mesh": { "big": true } }, "o2", 5, null, { "mesh": 1 }],
        "groups": [{ "id": "g1", "name": "G", "parentId": null }],
        "materials": [{ "id": "m1", "name": "M", "reused": true }],
        "textures": [],
        "transform": { "position": [0, 0, 0] }, "vertexCount": 8, "warnings": ["w"], "parentId": null
      }))
    })
  });
  let output = batch(&mock, json!({ "commands": [add("a"), { "tool": "scene_fail" }], "resultMode": "ids", "continueOnError": true }));
  assert_eq!(
    output.value["results"],
    json!([{ "index": 0, "result": {
      "id": "i", "name": "n", "ids": ["a", "b"], "objectId": "o", "objectIds": ["o1"], "groupId": "g",
      "materialId": "m", "textureId": "t", "layerId": "l", "modifierId": "mod",
      "objects": [{ "id": "o1", "name": "O" }, "o2", 5],
      "groups": [{ "id": "g1", "name": "G" }],
      "materials": [{ "id": "m1", "name": "M" }]
    } }])
  );
  // Failures are in `errors`, not in `results`.
  assert_eq!(output.value["errors"], json!([{ "index": 1, "tool": "scene_fail", "message": "boom" }]));
}

#[test]
fn summary_mode_returns_counts_labels_and_the_last_image() {
  let mock = Mock::new();
  let output = batch(&mock, json!({ "commands": scene(), "resultMode": "summary", "documentId": "doc2" }));
  assert!(!output.is_error);
  assert_eq!(
    output.value,
    json!({
      "resultMode": "summary",
      "total": 6,
      "completed": 6,
      "failed": 0,
      "labels": { "seat": "obj1", "shot1": null, "grp": "grp4" },
      "objectCount": 3,
      "document": { "id": "doc2", "name": "Other" }
    })
  );
  assert_eq!(output.images, [("IMG6".to_string(), "image/png".to_string())]);

  let failing = batch(&Mock::new(), json!({ "commands": [add("a"), { "tool": "scene_fail" }], "resultMode": "summary" }));
  assert!(failing.is_error && failing.value.get("results").is_none());
  assert_eq!(failing.value["errors"], json!([{ "index": 1, "tool": "scene_fail", "message": "boom" }]));
}

#[test]
fn images_are_not_kept_in_results_that_references_read() {
  let mock = Mock::new();
  let output = batch(
    &mock,
    json!({ "commands": [
      { "tool": "view_screenshot", "as": "shot" },
      { "tool": "scene_transform", "params": { "w": "$shot.width" } },
      { "tool": "scene_transform", "params": { "w": "$shot.image" } }
    ] }),
  );
  assert_eq!(params_of(&mock, "scene.transform", 0), json!({ "w": 64 }));
  assert!(only_error(&output).contains("has no field \"image\""));
  assert_eq!(output.images.len(), 1);
}

#[test]
fn the_document_is_reported_as_unknown_when_it_cannot_be_read() {
  let unknown = batch(&Mock::new(), json!({ "commands": [add("a")], "documentId": "gone" }));
  assert_eq!(unknown.value["document"], Value::Null);
  assert_eq!(unknown.value["objectCount"], Value::Null);
  let broken = Mock::with(|command, _| (command == "document.list").then(|| Err("no".into())));
  let output = batch(&broken, json!({ "commands": [add("a")] }));
  assert!(!output.is_error);
  assert_eq!(output.value["document"], Value::Null);
}

// ---- documentId ------------------------------------------------------------------------------

#[test]
fn document_id_is_forwarded_to_every_command() {
  let mock = Mock::new();
  let dir = TempDir::new("batch-document");
  let model = dir.file("chair.glb", [1u8, 2, 3]);
  let output = batch(
    &mock,
    json!({ "documentId": "doc2", "commands": [
      add("a"),
      { "tool": "scene_transform" },
      { "tool": "scene_transform", "params": { "documentId": "doc1" } },
      { "tool": "scene_place_model", "params": { "path": model }, "as": "chair" },
      { "tool": "scene_transform", "params": { "id": "$chair" } }
    ] }),
  );
  assert!(!output.is_error, "{}", output.value);
  assert_eq!(params_of(&mock, "scene.add_primitive", 0)["documentId"], "doc2");
  assert_eq!(params_of(&mock, "scene.transform", 0), json!({ "documentId": "doc2" }));
  // A command's own documentId wins.
  assert_eq!(params_of(&mock, "scene.transform", 1), json!({ "documentId": "doc1" }));
  // Native tools forward it to the commands they call, and their group id is the result's id.
  assert_eq!(params_of(&mock, "import.file", 0)["documentId"], "doc2");
  assert_eq!(params_of(&mock, "scene.transform", 2), json!({ "id": "g9", "documentId": "doc2" }));
  assert_eq!(output.value["document"], json!({ "id": "doc2", "name": "Other" }));
  assert_eq!(output.value["objectCount"], 3);

  // Without documentId nothing is added.
  let mock = Mock::new();
  batch(&mock, json!({ "commands": [{ "tool": "scene_transform" }] }));
  assert_eq!(params_of(&mock, "scene.transform", 0), json!({}));
}

// ---- validateOnly ----------------------------------------------------------------------------

#[test]
fn validate_only_executes_nothing() {
  let mock = Mock::new();
  let output = batch(&mock, json!({ "commands": scene(), "validateOnly": true, "documentId": "doc2" }));
  assert!(!output.is_error);
  assert_eq!(output.value, json!({ "valid": true, "commands": 6, "errors": [], "paramsValidated": true }));
  assert!(mock.executed().is_empty());
  // The frontend gets every command with its dotted id; references are placeholders.
  assert_eq!(mock.calls().len(), 1);
  assert_eq!(
    params_of(&mock, "app.validate_commands", 0),
    json!({ "commands": [
      { "command": "scene.add_primitive", "params": { "type": "cube", "name": "Seat" } },
      { "command": "view.screenshot", "params": {} },
      { "command": "scene.transform", "params": { "id": "reference" } },
      { "command": "group.create", "params": { "ids": ["reference"] } },
      { "command": "scene.null", "params": {} },
      { "command": "view.screenshot", "params": {} }
    ] })
  );
}

#[test]
fn validate_only_reports_structure_and_schema_errors() {
  let mock = Mock::with(|command, _| {
    (command == "app.validate_commands").then(|| {
      Ok(json!({ "valid": false, "errors": [
        { "index": 1, "message": "Invalid parameters: position must be an array" },
        { "index": 2, "message": "size: expected number, received string" },
        { "index": 99, "message": "out of range, ignored" },
        "garbage"
      ] }))
    })
  });
  let dir = TempDir::new("batch-validate");
  let output = batch(
    &mock,
    json!({ "validateOnly": true, "commands": [
      labelled("a", "seat"),
      { "tool": "scene_nope" },
      { "tool": "scene_transform", "params": { "position": 5, "id": "$seat", "text": "$$x" }, "as": "move" },
      { "tool": "scene_add_primitive", "params": { "size": "$seat.vertexCount" } },
      { "tool": "scene_transform", "params": { "id": "$later" } },
      { "tool": "scene_place_model", "params": { "path": "chair.glb" } },
      { "tool": "scene_place_model", "params": { "path": dir.path("chair.glb"), "position": "$seat.position" } },
      { "tool": "file_save", "params": { "path": dir.path("out.tessel"), "documentId": "$seat" } }
    ] }),
  );
  assert!(output.is_error);
  assert!(mock.executed().is_empty());
  assert_eq!(output.value["valid"], false);
  assert_eq!(output.value["commands"], 8);
  assert_eq!(output.value["paramsValidated"], true);
  let errors = output.value["errors"].as_array().unwrap();
  let summary: Vec<(u64, &str)> = errors.iter().map(|e| (e["index"].as_u64().unwrap(), e["message"].as_str().unwrap())).collect();
  assert_eq!(summary.len(), 4, "{summary:?}");
  assert!(summary[0].0 == 1 && summary[0].1.contains("Unknown tool \"scene_nope\""));
  // Index 1 of the validated list is command 2 of the batch (command 1 was not sent).
  assert_eq!(summary[1], (2, "Invalid parameters: position must be an array"));
  assert_eq!(errors[1]["tool"], "scene_transform");
  assert_eq!(errors[1]["as"], "move");
  assert!(summary[2].0 == 4 && summary[2].1.contains("there is no label \"later\""));
  assert!(summary[3].0 == 5 && summary[3].1.contains("not an absolute path"));
  // A command fed by a "$label.path" reference only gets a warning: its value is a placeholder.
  let warnings = output.value["warnings"].as_array().unwrap();
  assert_eq!(warnings.len(), 2);
  assert_eq!(warnings[0], json!({ "index": 3, "tool": "scene_add_primitive", "message": "size: expected number, received string" }));
  assert_eq!(warnings[1]["index"], 6);
  assert!(output.value["warningsNote"].is_string());
  // Only the commands without structural problems were sent, escapes resolved.
  assert_eq!(
    params_of(&mock, "app.validate_commands", 0),
    json!({ "commands": [
      { "command": "scene.add_primitive", "params": { "type": "cube", "name": "a" } },
      { "command": "scene.transform", "params": { "position": 5, "id": "reference", "text": "$x" } },
      { "command": "scene.add_primitive", "params": { "size": "reference" } }
    ] })
  );
}

#[test]
fn validate_only_says_when_params_cannot_be_validated() {
  // An editor without app.validate_commands: the structural checks still count.
  let old = Mock::without("app_validate_commands");
  let output = batch(&old, json!({ "commands": scene(), "validateOnly": true }));
  assert!(!output.is_error);
  assert_eq!(output.value["valid"], true);
  assert_eq!(output.value["paramsValidated"], false);
  assert!(output.value["note"].as_str().unwrap().contains("NOT validated"));
  assert!(old.calls().is_empty());

  let invalid = batch(&old, json!({ "commands": [{ "tool": "scene_transform", "params": { "id": "$x" } }], "validateOnly": true }));
  assert_eq!(invalid.value["valid"], false);

  // The validation itself failing is not a verdict on the commands either.
  let failing = Mock::with(|command, _| (command == "app.validate_commands").then(|| Err("timed out".into())));
  let output = batch(&failing, json!({ "commands": scene(), "validateOnly": true }));
  assert_eq!(output.value["valid"], true);
  assert_eq!(output.value["paramsValidated"], false);
  assert!(output.value["note"].as_str().unwrap().contains("timed out"));

  // "Invalid" without usable details must not read as valid.
  let vague = Mock::with(|command, _| (command == "app.validate_commands").then(|| Ok(json!({ "valid": false, "errors": "?" }))));
  let output = batch(&vague, json!({ "commands": scene(), "validateOnly": true }));
  assert_eq!(output.value["valid"], false);

  // Only native tools: nothing to ask the editor.
  let native = Mock::new();
  let path = TempDir::new("batch-validate-native").path("a.tessel");
  let output = batch(&native, json!({ "validateOnly": true, "commands": [{ "tool": "file_save", "params": { "path": path } }] }));
  assert_eq!(output.value, json!({ "valid": true, "commands": 1, "errors": [], "paramsValidated": true }));
  assert!(native.calls().is_empty());
}

#[test]
fn validate_only_reports_file_problems_as_a_result() {
  let mock = Mock::new();
  let dir = TempDir::new("batch-validate-file");
  let missing = batch(&mock, json!({ "file": dir.path("missing.json"), "validateOnly": true }));
  assert!(missing.is_error);
  assert_eq!(missing.value["valid"], false);
  assert_eq!(missing.value["commands"], 0);
  assert!(missing.value["errors"][0]["message"].as_str().unwrap().contains("Could not read"));

  let file = dir.file("ok.json", scene().to_string());
  let output = batch(&mock, json!({ "file": file, "validateOnly": true }));
  assert_eq!(output.value, json!({ "valid": true, "commands": 6, "errors": [], "paramsValidated": true }));
  assert!(mock.executed().is_empty());
}

// ---- untrusted input -------------------------------------------------------------------------

#[test]
fn reference_parsing() {
  assert_eq!(parse_reference("plain"), Ok(Parsed::Literal));
  assert_eq!(parse_reference(""), Ok(Parsed::Literal));
  assert_eq!(parse_reference("a$b"), Ok(Parsed::Literal));
  assert_eq!(parse_reference("$$"), Ok(Parsed::Escaped("$")));
  assert_eq!(parse_reference("$$a.b"), Ok(Parsed::Escaped("$a.b")));
  assert_eq!(parse_reference("$a"), Ok(Parsed::Reference { target: Target::Label("a"), path: vec![] }));
  assert_eq!(parse_reference("$a-b_1.x.0.y z"), Ok(Parsed::Reference { target: Target::Label("a-b_1"), path: vec!["x", "0", "y z"] }));
  assert_eq!(parse_reference("$007"), Ok(Parsed::Reference { target: Target::Index(7), path: vec![] }));
  assert_eq!(parse_reference("$prev.id"), Ok(Parsed::Reference { target: Target::Prev, path: vec!["id"] }));
  assert_eq!(parse_reference("$previous"), Ok(Parsed::Reference { target: Target::Label("previous"), path: vec![] }));
  assert!(parse_reference("$\u{e4}").is_err());
  assert!(parse_reference("$a b").is_err());
}

/// A small deterministic generator, enough to throw odd shapes at the engine.
struct Random(u64);

impl Random {
  fn next(&mut self, bound: u64) -> u64 {
    self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    (self.0 >> 33) % bound
  }

  fn string(&mut self) -> String {
    const PIECES: [&str; 22] = [
      "$", "$$", "a", "prev", "0", "1", "99", ".", "..", "id", "name", "objects", "seat", "grp", " ", "-", "_", "\u{e4}",
      "__proto__", "constructor", "18446744073709551616", "\n",
    ];
    (0..self.next(5)).map(|_| PIECES[self.next(PIECES.len() as u64) as usize]).collect()
  }

  fn value(&mut self, depth: usize) -> Value {
    match self.next(if depth > 3 { 6 } else { 9 }) {
      0 => Value::Null,
      1 => json!(self.next(2) == 0),
      2 => json!(self.next(1000) as i64 - 500),
      3 => json!(1.0e300 * self.next(3) as f64),
      4 | 5 => json!(self.string()),
      6 => Value::Array((0..self.next(4)).map(|_| self.value(depth + 1)).collect()),
      _ => Value::Object((0..self.next(4)).map(|_| (self.string(), self.value(depth + 1))).collect()),
    }
  }

  fn command(&mut self) -> Value {
    const TOOLS: [&str; 9] = [
      "scene_add_primitive", "scene_transform", "group_create", "scene_fail", "scene_null", "view_screenshot", "batch",
      "file_save", "scene_place_model",
    ];
    match self.next(10) {
      0 => self.value(0),
      _ => {
        let mut command = serde_json::Map::new();
        if self.next(12) != 0 {
          let tool = if self.next(8) == 0 { self.value(1) } else { json!(TOOLS[self.next(TOOLS.len() as u64) as usize]) };
          command.insert("tool".into(), tool);
        }
        if self.next(3) != 0 {
          let params = if self.next(8) == 0 { self.value(0) } else { json!({ "a": self.value(0), "b": self.string() }) };
          command.insert("params".into(), params);
        }
        if self.next(3) == 0 {
          let label = if self.next(6) == 0 { self.value(1) } else { json!(["seat", "grp", "a", "prev", "1", "x y"][self.next(6) as usize]) };
          command.insert("as".into(), label);
        }
        if self.next(15) == 0 {
          command.insert(self.string(), self.value(1));
        }
        Value::Object(command)
      }
    }
  }
}

#[test]
fn odd_input_never_panics() {
  let mut random = Random(0x7e55e1);
  for round in 0..1500 {
    let commands: Vec<Value> = (0..random.next(6)).map(|_| random.command()).collect();
    let mut args = json!({ "commands": commands });
    if random.next(3) == 0 {
      args["continueOnError"] = json!(true);
    }
    if random.next(4) == 0 {
      args["validateOnly"] = json!(true);
    }
    if random.next(3) == 0 {
      args["resultMode"] = json!(["full", "ids", "summary"][random.next(3) as usize]);
    }
    if random.next(10) == 0 {
      args["documentId"] = random.value(2);
    }
    if random.next(20) == 0 {
      args = random.value(0);
    }
    // Editors that answer with odd shapes too.
    let mock = match round % 3 {
      0 => Mock::new(),
      1 => Mock::with(|_, params| Some(Ok(params.clone()))),
      _ => Mock::with(|command, _| match command {
        "document.list" => Some(Ok(json!({ "documents": [5, null, { "active": "yes" }] }))),
        "app.validate_commands" => Some(Ok(json!({ "valid": "?", "errors": [{ "index": -1 }, { "index": 1e99 }, { "index": 0, "message": 7 }] }))),
        _ => Some(Ok(json!([{ "id": { "nested": true } }]))),
      }),
    };
    let output = batch(&mock, args.clone());
    // Whatever came in, the answer is a value that can be sent, and errors are marked.
    let text = output.value.to_string();
    assert!(!text.is_empty());
    if let Some(failed) = output.value.get("failed").and_then(Value::as_u64) {
      assert_eq!(failed > 0, output.is_error, "{args} -> {text}");
    }
    if args.get("validateOnly") == Some(&json!(true)) {
      assert!(mock.executed().is_empty(), "{args}");
    }
  }
}

#[test]
fn results_of_any_shape_can_be_referenced_or_reduced() {
  for result in [json!(null), json!(5), json!("text"), json!([1, 2]), json!({ "id": null }), json!({ "id": { "a": 1 }, "objects": "none", "ids": 5 })] {
    let shape = result.clone();
    let mock = Mock::with(move |command, _| (command == "scene.add_primitive").then(|| Ok(shape.clone())));
    for mode in ["full", "ids", "summary"] {
      let output = batch(
        &mock,
        json!({ "resultMode": mode, "continueOnError": true, "commands": [
          labelled("a", "x"),
          { "tool": "scene_transform", "params": { "a": "$x" } },
          { "tool": "scene_transform", "params": { "a": "$x.id.a" } },
          { "tool": "scene_transform", "params": { "a": "$x.0" } }
        ] }),
      );
      assert_eq!(output.value["total"], 4, "{result} {mode}");
    }
  }
}
