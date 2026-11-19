use serde_json::{Value, json};

use super::*;
use crate::testing::{Mock, TempDir, call, error_of};

fn params_of(mock: &Mock, command: &str) -> Value {
  let calls = mock.calls_of(command);
  assert_eq!(calls.len(), 1, "calls of {command}");
  calls[0].clone()
}

#[test]
fn place_model_checks_the_path_and_params_before_reading() {
  let mock = Mock::new();
  let dir = TempDir::new("place-checks");
  let model = dir.file("chair.glb", [1u8, 2, 3]);
  let run = |args: Value| error_of(&call(&mock, "scene_place_model", args));

  assert!(run(json!({})).contains("\"path\" is required"));
  assert!(run(json!({ "path": 5 })).contains("\"path\" must be a non-empty string"));
  assert!(run(json!({ "path": "chair.glb" })).contains("not an absolute path"));
  assert!(run(json!({ "path": "..\\..\\chair.glb" })).contains("not an absolute path"));
  assert!(run(json!({ "path": dir.path("chair") })).contains("has no file extension"));
  let wrong = run(json!({ "path": dir.path("chair.exe") }));
  assert!(wrong.contains("Cannot place .exe files") && wrong.contains(".tessel"), "{wrong}");
  assert!(run(json!({ "path": dir.path("chair.usdz") })).contains("Cannot place .usdz files"));
  assert!(run(json!({ "path": dir.path("wood.png") })).contains("Use file_import to add an image"));
  assert!(run(json!({ "path": dir.path("missing.glb") })).contains("Could not read"));
  assert!(run(json!({ "path": dir.file("empty.glb", "") })).contains("is empty"));
  assert!(run(json!({ "path": dir.path("x.GLB.txt") })).contains("Cannot place .txt"));

  for (key, value, expected) in [
    ("position", json!([1, 2]), "\"position\" must be an array of three numbers"),
    ("position", json!("0 0 0"), "\"position\" must be an array of three numbers"),
    ("position", json!([1, 2, "3"]), "\"position\" must be an array of three numbers"),
    ("rotation", json!({ "x": 1 }), "\"rotation\" must be an array of three numbers"),
    ("scale", json!([1, 2]), "\"scale\" must be a number or an array"),
    ("scale", json!("2"), "\"scale\" must be a number or an array"),
    ("groupId", json!(5), "\"groupId\" must be a group id or name"),
    ("groupId", json!(""), "\"groupId\" must be a group id or name"),
    ("name", json!(5), "\"name\" must be a non-empty string"),
    ("reuseMaterials", json!("yes"), "\"reuseMaterials\" must be true or false"),
    ("documentId", json!(1), "\"documentId\" must be a non-empty string"),
    ("postion", json!([0, 0, 0]), "Unknown parameter \"postion\" for scene_place_model"),
  ] {
    let mut args = json!({ "path": model });
    args[key] = value;
    let message = run(args);
    assert!(message.contains(expected), "{key}: {message}");
  }
  assert!(error_of(&call(&mock, "scene_place_model", json!([1]))).contains("must be an object"));
  assert!(mock.calls().is_empty());
}

#[test]
fn place_model_forwards_the_file_and_the_placement() {
  let dir = TempDir::new("place-run");
  let model = dir.file("Dining Chair.GLB", [1u8, 2, 3]);

  let mock = Mock::new();
  let output = call(&mock, "scene_place_model", json!({ "path": model }));
  assert!(!output.is_error, "{}", output.value);
  // Defaults: only the group name (the file stem) is added.
  assert_eq!(
    params_of(&mock, "import.file"),
    json!({ "format": "glb", "name": "Dining Chair.GLB", "base64": "AQID", "groupName": "Dining Chair" })
  );
  assert_eq!(
    output.value,
    json!({
      "placed": true, "path": model, "format": "glb", "bytes": 3, "id": "g9", "groupId": "g9",
      "objects": [{ "id": "o1", "name": "Seat" }, { "id": "o2", "name": "Leg" }],
      "groups": [{ "id": "g9", "name": "chair" }],
      "materials": [{ "id": "m1", "name": "Oak" }],
      "textures": [], "warnings": [],
      "bounds": { "min": [0, 0, 0], "max": [1, 1, 1] }
    })
  );

  let mock = Mock::new();
  let args = json!({
    "path": model, "position": [1, 0.5, -2], "rotation": [0, 90, 0], "scale": [1, 2, 1], "groupId": "Furniture",
    "name": " Chair 1 ", "reuseMaterials": false, "documentId": "doc2"
  });
  assert!(!call(&mock, "scene_place_model", args).is_error);
  assert_eq!(
    params_of(&mock, "import.file"),
    json!({
      "format": "glb", "name": "Dining Chair.GLB", "base64": "AQID", "position": [1, 0.5, -2], "rotation": [0, 90, 0],
      "scale": [1, 2, 1], "groupId": "Furniture", "groupName": "Chair 1", "reuseMaterials": false, "documentId": "doc2"
    })
  );

  // null and a uniform scale; an explicit null parent is passed on.
  let mock = Mock::new();
  let args = json!({ "path": model, "position": null, "scale": 2, "groupId": null, "name": null });
  assert!(!call(&mock, "scene_place_model", args).is_error);
  let params = params_of(&mock, "import.file");
  assert_eq!(params["scale"], 2);
  assert_eq!(params["groupId"], Value::Null);
  assert!(params.as_object().unwrap().contains_key("groupId") && params.get("position").is_none());
}

#[test]
fn place_model_reads_projects_as_text() {
  let dir = TempDir::new("place-tessel");
  let mock = Mock::new();
  // With a byte order mark, as an editor on Windows may write it.
  let project = dir.file("table.tessel", [&[0xef, 0xbb, 0xbf][..], "{\"name\":\"T\u{e4}st\"}".as_bytes()].concat());
  let output = call(&mock, "scene_place_model", json!({ "path": project, "position": [0, 0, 1] }));
  assert!(!output.is_error, "{}", output.value);
  assert_eq!(
    params_of(&mock, "import.file"),
    json!({ "format": "tessel", "name": "table.tessel", "text": "{\"name\":\"T\u{e4}st\"}", "groupName": "table", "position": [0, 0, 1] })
  );
  assert_eq!(output.value["format"], "tessel");

  let binary = dir.file("broken.tessel", [0xc3u8, 0x28]);
  assert!(error_of(&call(&mock, "scene_place_model", json!({ "path": binary }))).contains("is not a Tessel project file"));

  // What the editor says is passed on, and its fields never replace the tool's own.
  let failing = Mock::with(|command, _| (command == "import.file").then(|| Err("The file contains no meshes".into())));
  assert_eq!(error_of(&call(&failing, "scene_place_model", json!({ "path": project }))), "The file contains no meshes");
  let old = Mock::with(|command, _| (command == "import.file").then(|| Ok(json!({ "objects": [], "format": "x", "id": 5 }))));
  let output = call(&old, "scene_place_model", json!({ "path": project }));
  assert_eq!(output.value["format"], "tessel");
  assert_eq!(output.value["id"], 5);
}

#[test]
fn material_import_checks_and_forwards() {
  let dir = TempDir::new("material-import");
  let mock = Mock::new();
  let project = dir.file("library.tessel", "{\"materials\":[]}");
  let run = |args: Value| error_of(&call(&mock, "material_import", args));

  assert!(run(json!({})).contains("\"path\" is required"));
  assert!(run(json!({ "path": "library.tessel" })).contains("not an absolute path"));
  assert!(run(json!({ "path": dir.path("library.glb") })).contains("must end in .tessel"));
  assert!(run(json!({ "path": dir.path("library") })).contains("must end in .tessel"));
  assert!(run(json!({ "path": dir.path("missing.tessel") })).contains("Could not read"));
  assert!(run(json!({ "path": dir.file("empty.tessel", " ") })).contains("is empty"));
  assert!(run(json!({ "path": project, "names": "Oak" })).contains("\"names\" must be an array of material names"));
  assert!(run(json!({ "path": project, "names": ["Oak", 5] })).contains("\"names\" must be an array of material names"));
  assert!(run(json!({ "path": project, "names": [""] })).contains("\"names\" must be an array of material names"));
  assert!(run(json!({ "path": project, "name": "Oak" })).contains("Unknown parameter \"name\" for material_import"));
  assert!(mock.calls().is_empty());

  let output = call(&mock, "material_import", json!({ "path": project, "names": ["Oak"], "documentId": "doc2" }));
  assert!(!output.is_error, "{}", output.value);
  assert_eq!(
    params_of(&mock, "material.import"),
    json!({ "json": "{\"materials\":[]}", "names": ["Oak"], "documentId": "doc2" })
  );
  // One material: its id is the id of the result.
  assert_eq!(
    output.value,
    json!({ "imported": true, "path": project, "id": "m1", "materials": [{ "id": "m1", "name": "Oak", "reused": false }] })
  );

  let several = Mock::with(|command, _| {
    (command == "material.import").then(|| {
      Ok(json!({ "materials": [{ "id": "m1", "name": "A", "reused": true }, { "id": "m2", "name": "B", "reused": false }] }))
    })
  });
  let output = call(&several, "material_import", json!({ "path": project }));
  assert!(output.value.get("id").is_none());
  assert_eq!(params_of(&several, "material.import"), json!({ "json": "{\"materials\":[]}" }));
  assert_eq!(output.value["materials"][1]["id"], "m2");
}

#[test]
fn file_save_reports_the_rename_and_the_object_count() {
  let dir = TempDir::new("file-save");
  let mock = Mock::new();
  let path = dir.0.join("sub").join("Chair.tessel").to_string_lossy().into_owned();
  let output = call(&mock, "file_save", json!({ "path": path }));
  assert!(!output.is_error, "{}", output.value);
  assert_eq!(
    output.value,
    json!({ "saved": true, "path": path, "name": "Chair", "bytes": 12, "id": "doc1", "renamedFrom": "Model", "objectCount": 7 })
  );
  assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"tessel\":1}");
  assert_eq!(params_of(&mock, "document.serialize"), json!({}));
  assert_eq!(params_of(&mock, "document.mark_saved"), json!({ "id": "doc1", "filePath": path, "name": "Chair" }));

  // Saving under the name the document already has is not a rename; documentId picks the document.
  let mock = Mock::new();
  let same = dir.path("Model.tessel");
  let output = call(&mock, "file_save", json!({ "path": same, "documentId": "doc2" }));
  assert_eq!(
    output.value,
    json!({ "saved": true, "path": same, "name": "Model", "bytes": 12, "id": "doc2", "objectCount": 3 })
  );
  assert_eq!(params_of(&mock, "document.serialize"), json!({ "id": "doc2" }));
  assert_eq!(params_of(&mock, "document.mark_saved")["id"], "doc2");

  // Without a path the document's own file is used.
  let own = same.clone();
  let saved = Mock::with(move |command, _| {
    (command == "document.serialize").then(|| Ok(json!({ "id": "doc1", "name": "Model", "filePath": own, "json": "{}" })))
  });
  assert_eq!(call(&saved, "file_save", json!({})).value["path"], json!(same));

  let run = |args: Value| error_of(&call(&mock, "file_save", args));
  assert!(run(json!({ "path": "Chair.tessel" })).contains("not an absolute path"));
  assert!(run(json!({ "path": dir.path("Chair.json") })).contains("must end in .tessel"));
  assert!(run(json!({ "path": 5 })).contains("\"path\" must be a non-empty string"));
  assert!(run(json!({ "file": same })).contains("Unknown parameter \"file\" for file_save"));
  assert!(error_of(&call(&Mock::new(), "file_save", json!({}))).contains("has never been saved"));
}

#[test]
fn file_export_returns_absolute_paths() {
  let dir = TempDir::new("file-export");
  let mock = Mock::new();
  let out = dir.0.join("out");
  let full = |name: &str| out.join(name).to_string_lossy().into_owned();
  let obj = full("chair.obj");
  let output = call(&mock, "file_export", json!({ "path": obj, "documentId": "doc2" }));
  assert!(!output.is_error, "{}", output.value);
  let files = [obj.clone(), full("chair.mtl"), full("chair_wood.png")];
  assert_eq!(
    output.value,
    json!({ "exported": true, "path": obj, "format": "obj", "bytes": 4, "files": files, "selectionOnly": false })
  );
  for file in &files {
    assert!(std::path::Path::new(file).is_absolute() && std::path::Path::new(file).is_file(), "{file}");
  }
  assert_eq!(
    params_of(&mock, "export.file"),
    json!({ "format": "obj", "selectionOnly": false, "name": "chair", "documentId": "doc2" })
  );

  let mock = Mock::new();
  let glb = dir.path("chair.glb");
  let output = call(&mock, "file_export", json!({ "path": glb, "selectionOnly": true }));
  assert_eq!(output.value["files"], json!([glb]));
  assert_eq!(output.value["bytes"], 4);
  assert_eq!(params_of(&mock, "export.file"), json!({ "format": "glb", "selectionOnly": true, "name": "chair" }));

  let run = |args: Value| error_of(&call(&mock, "file_export", args));
  assert!(run(json!({ "path": "chair.glb" })).contains("not an absolute path"));
  assert!(run(json!({ "path": dir.path("chair.fbx") })).contains("Cannot export to .fbx"));
  assert!(run(json!({ "path": glb, "selectionOnly": "yes" })).contains("\"selectionOnly\" must be true or false"));
}

#[test]
fn render_image_checks_the_path_and_forwards_the_rest() {
  let dir = TempDir::new("render-image");
  let reply = |command: &str, params: &Value| {
    (command == "render.image").then(|| {
      let mime = format!("image/{}", params.get("format").and_then(Value::as_str).unwrap_or("png"));
      Ok(json!({ "image": { "mimeType": mime, "base64": "AQIDBA==" }, "width": 64, "height": 32, "samples": 8, "seconds": 1.5, "converged": true }))
    })
  };

  // Without a path the picture comes back and nothing is written.
  let mock = Mock::with(reply);
  let mut output = call(&mock, "render_image", json!({ "width": 64, "sun": { "elevation": 30 }, "documentId": "doc2" }));
  assert!(!output.is_error, "{}", output.value);
  assert_eq!(take_image(&mut output.value), Some(("AQIDBA==".to_string(), "image/png".to_string())));
  assert_eq!(output.value, json!({ "rendered": true, "width": 64, "height": 32, "samples": 8, "seconds": 1.5, "converged": true }));
  assert_eq!(params_of(&mock, "render.image"), json!({ "width": 64, "sun": { "elevation": 30 }, "documentId": "doc2" }));

  // With a path the file is written (folders created), the format follows the extension and the picture still comes back.
  let mock = Mock::with(reply);
  let jpg = dir.0.join("out").join("factory.JPG").to_string_lossy().into_owned();
  let mut output = call(&mock, "render_image", json!({ "path": jpg, "maxSeconds": 5 }));
  assert!(!output.is_error, "{}", output.value);
  assert_eq!(std::fs::read(&jpg).unwrap(), [1, 2, 3, 4]);
  assert_eq!(take_image(&mut output.value).unwrap().1, "image/jpeg");
  assert_eq!(output.value["path"], json!(jpg));
  assert_eq!(output.value["bytes"], 4);
  assert_eq!(params_of(&mock, "render.image"), json!({ "maxSeconds": 5, "format": "jpeg" }));

  // An image that went to a file is not returned inline when asked not to.
  let mock = Mock::with(reply);
  let webp = dir.path("a.webp");
  let mut output = call(&mock, "render_image", json!({ "path": webp, "returnImage": false, "format": "webp" }));
  assert!(take_image(&mut output.value).is_none());
  assert!(output.value["image"].as_str().unwrap().contains("written to path"));
  assert!(std::path::Path::new(&webp).is_file());

  // Everything is checked before the editor is asked to render.
  let mock = Mock::with(reply);
  let run = |args: Value| error_of(&call(&mock, "render_image", args));
  assert!(run(json!({ "path": "render.png" })).contains("not an absolute path"));
  assert!(run(json!({ "path": dir.path("render.glb") })).contains("Cannot write a rendered image as .glb"));
  assert!(run(json!({ "path": dir.path("render") })).contains("has no file extension"));
  assert!(run(json!({ "path": dir.path("render.exe") })).contains("Cannot write a rendered image as .exe"));
  assert!(run(json!({ "path": dir.path("b.png"), "format": "jpeg" })).contains("make them agree"));
  assert!(run(json!({ "format": "bmp" })).contains("must be png, jpeg or webp"));
  assert!(run(json!({ "maxSeconds": 601 })).contains("\"maxSeconds\" must be a number from 1 to 600"));
  assert!(run(json!({ "maxSeconds": "long" })).contains("\"maxSeconds\""));
  assert!(run(json!({ "returnImage": false })).contains("give a path"));
  assert!(run(json!({ "paht": dir.path("b.png") })).contains("Unknown parameter \"paht\""));
  assert!(run(json!({ "path": "" })).contains("\"path\" must be a non-empty string"));
  assert!(mock.calls_of("render.image").is_empty());
  assert!(!std::path::Path::new(&dir.path("b.png")).exists());

  // A failed render writes nothing and passes the message of the editor on.
  let failing = Mock::with(|command, _| (command == "render.image").then(|| Err("Nothing to render: the document has no objects.".into())));
  let png = dir.path("none.png");
  assert!(error_of(&call(&failing, "render_image", json!({ "path": png }))).contains("Nothing to render"));
  assert!(!std::path::Path::new(&png).exists());

  // The wait covers the sampling budget plus preparation; without a budget, the longest one.
  assert_eq!(render_timeout(Some(30.0)).as_secs(), 270);
  assert_eq!(render_timeout(None).as_secs(), 840);
  assert!(render_timeout(Some(1.0)) > crate::bridge::CALL_TIMEOUT);
  assert!(check_native("render_image", &json!({ "path": "x.png" })).is_err());
  assert!(check_native("render_image", &json!({ "samples": 16 })).is_ok());
}

#[test]
fn file_import_and_open_forward_the_document() {
  let dir = TempDir::new("file-import");
  let mock = Mock::new();
  let model = dir.file("part.stl", [9u8; 4]);
  let output = call(&mock, "file_import", json!({ "path": model, "documentId": "doc2" }));
  assert!(!output.is_error, "{}", output.value);
  assert_eq!(
    params_of(&mock, "import.file"),
    json!({ "format": "stl", "name": "part.stl", "base64": "CQkJCQ==", "documentId": "doc2" })
  );
  assert_eq!(output.value["imported"], true);
  assert_eq!(output.value["objects"][0]["id"], "o1");

  let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
  png.extend([0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0]);
  let image = dir.file("wood.png", png);
  let output = call(&mock, "file_import", json!({ "path": image, "documentId": "doc2" }));
  assert_eq!(output.value["texture"]["id"], "t1");
  assert_eq!(params_of(&mock, "texture.add")["documentId"], "doc2");

  let message = error_of(&call(&mock, "file_import", json!({ "path": dir.path("a.tessel") })));
  assert!(message.contains("file_open") && message.contains("scene_place_model"), "{message}");

  let project = dir.file("a.tessel", "{}");
  let output = call(&mock, "file_open", json!({ "path": project }));
  assert_eq!(output.value, json!({ "opened": true, "path": project, "id": "doc9", "name": "a" }));
  assert_eq!(params_of(&mock, "document.load"), json!({ "json": "{}", "filePath": project, "name": "a" }));

  // activate is forwarded as given: false opens the tab in the background.
  for activate in [false, true] {
    let mock = Mock::new();
    let output = call(&mock, "file_open", json!({ "path": project, "activate": activate }));
    assert_eq!(output.value["id"], "doc9");
    assert_eq!(
      params_of(&mock, "document.load"),
      json!({ "json": "{}", "filePath": project, "name": "a", "activate": activate })
    );
  }
  let message = error_of(&call(&mock, "file_open", json!({ "path": project, "activate": "no" })));
  assert!(message.contains("activate") && message.contains("true or false"), "{message}");
}

#[test]
fn unknown_tools_and_frontend_tools() {
  let mock = Mock::new();
  assert!(error_of(&call(&mock, "scene_nope", json!({}))).contains("Unknown tool \"scene_nope\". Use tools/list"));
  let starting = call(&Mock::starting(), "scene_add_primitive", json!({}));
  assert!(error_of(&starting).contains("has not registered its commands yet"));
  let output = call(&mock, "scene_add_primitive", json!({ "name": "A", "documentId": "doc2" }));
  assert_eq!(output.value["id"], "obj1");
  // A frontend tool gets its arguments untouched, documentId included.
  assert_eq!(params_of(&mock, "scene.add_primitive"), json!({ "name": "A", "documentId": "doc2" }));
}

#[test]
fn every_native_tool_is_listed_with_document_id() {
  let listed = native_tools();
  assert_eq!(listed.len(), NATIVE_NAMES.len());
  for tool in &listed {
    assert!(is_native(tool.name), "{}", tool.name);
    assert_eq!(tool.input_schema["type"], "object");
    assert!(tool.input_schema["properties"]["documentId"].is_object(), "{}", tool.name);
    assert!(!tool.description.contains("  "), "{}: the description has a run of spaces", tool.name);
  }
}

#[test]
fn text_files_are_decoded() {
  assert_eq!(files::decode_text(b"abc").unwrap(), "abc");
  assert_eq!(files::decode_text(&[0xef, 0xbb, 0xbf, b'a']).unwrap(), "a");
  assert_eq!(files::decode_text(&[0xff, 0xfe, b'a', 0, 0xe4, 0]).unwrap(), "a\u{e4}");
  assert_eq!(files::decode_text(&[0xfe, 0xff, 0, b'a']).unwrap(), "a");
  assert!(files::decode_text(&[0xff, 0xfe, b'a']).is_err());
  assert!(files::decode_text(&[0xff, 0xfe, 0x00, 0xd8]).is_err());
  assert!(files::decode_text(&[0xc3, 0x28]).is_err());
  assert_eq!(files::decode_text(b"").unwrap(), "");
}
