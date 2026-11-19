//! A stand-in for the editor window, so that the tools can be tested without the app.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{Value, json};

use crate::bridge::{Frontend, Reply};
use crate::tools::{self, ToolOutput};

type Handler = Box<dyn Fn(&str, &Value) -> Option<Reply> + Send + Sync>;

pub struct Mock {
  tools: Vec<String>,
  calls: Mutex<Vec<(String, Value)>>,
  handler: Option<Handler>,
}

const TOOLS: [&str; 9] = [
  "scene_add_primitive",
  "scene_transform",
  "scene_fail",
  "scene_null",
  "group_create",
  "view_screenshot",
  "document_list",
  "app_get_state",
  "app_validate_commands",
];

impl Mock {
  pub fn new() -> Self {
    Self { tools: TOOLS.iter().map(|tool| tool.to_string()).collect(), calls: Mutex::new(Vec::new()), handler: None }
  }

  /// An editor that does not know `tool`.
  pub fn without(tool: &str) -> Self {
    let mut mock = Self::new();
    mock.tools.retain(|known| known != tool);
    mock
  }

  /// An editor window that has not registered its commands yet.
  pub fn starting() -> Self {
    let mut mock = Self::new();
    mock.tools.clear();
    mock
  }

  /// `handler` answers before the built-in replies; None falls through to them.
  pub fn with(handler: impl Fn(&str, &Value) -> Option<Reply> + Send + Sync + 'static) -> Self {
    let mut mock = Self::new();
    mock.handler = Some(Box::new(handler));
    mock
  }

  /// Every call that reached the editor: `(command, params)`.
  pub fn calls(&self) -> Vec<(String, Value)> {
    self.calls.lock().unwrap().clone()
  }

  /// The params of every call of `command`.
  pub fn calls_of(&self, command: &str) -> Vec<Value> {
    self.calls().into_iter().filter(|(name, _)| name == command).map(|(_, params)| params).collect()
  }

  /// Calls that change or render something (everything but the read-only bookkeeping calls).
  pub fn executed(&self) -> Vec<String> {
    self
      .calls()
      .into_iter()
      .map(|(name, _)| name)
      .filter(|name| name != "document.list" && name != "app.validate_commands")
      .collect()
  }

  fn reply(&self, command: &str, params: &Value, number: usize) -> Reply {
    if let Some(reply) = self.handler.as_ref().and_then(|handler| handler(command, params)) {
      return reply;
    }
    match command {
      "scene.add_primitive" => Ok(json!({
        "id": format!("obj{number}"),
        "name": params.get("name").cloned().unwrap_or(json!("Cube")),
        "vertexCount": 8
      })),
      "scene.transform" => Ok(json!({ "moved": true })),
      "scene.fail" => Err("boom".into()),
      "scene.null" => Ok(Value::Null),
      "group.create" => Ok(json!({
        "id": format!("grp{number}"),
        "name": "Group",
        "objects": [{ "id": "a1", "name": "A", "visible": true }, { "id": "a2", "name": "B", "visible": false }],
        "bounds": { "min": [0, 0, 0], "max": [1, 2.5, 3] }
      })),
      "view.screenshot" => Ok(json!({ "image": { "mimeType": "image/png", "base64": format!("IMG{number}") }, "width": 64 })),
      "document.list" => Ok(json!({ "documents": [
        { "id": "doc1", "name": "Model", "active": true, "objectCount": 7 },
        { "id": "doc2", "name": "Other", "active": false, "objectCount": 3 }
      ] })),
      "app.validate_commands" => Ok(json!({ "valid": true, "errors": [] })),
      "document.serialize" => Ok(json!({
        "id": params.get("id").cloned().unwrap_or(json!("doc1")),
        "name": "Model",
        "filePath": null,
        "json": "{\"tessel\":1}"
      })),
      "document.mark_saved" => Ok(Value::Null),
      "document.load" => Ok(json!({ "id": "doc9", "name": params.get("name").cloned().unwrap_or(Value::Null) })),
      "document.import_java" => Ok(json!({ "id": "doc10", "name": params.get("name").cloned().unwrap_or(Value::Null), "warnings": [] })),
      "export.file" => Ok(match params.get("format").and_then(Value::as_str) {
        Some("obj") => json!({
          "format": "obj", "text": "o a\n", "mtlName": "chair.mtl", "mtl": "newmtl a\n",
          "files": [{ "name": "chair_wood.png", "base64": "AQID" }]
        }),
        Some("gltf") => json!({ "format": "gltf", "text": "{}" }),
        _ => json!({ "format": "glb", "base64": "AQIDBA==" }),
      }),
      "import.file" => Ok(json!({
        "objects": [{ "id": "o1", "name": "Seat" }, { "id": "o2", "name": "Leg" }],
        "groups": [{ "id": "g9", "name": "chair" }],
        "materials": [{ "id": "m1", "name": "Oak" }],
        "textures": [],
        "warnings": [],
        "groupId": "g9",
        "bounds": { "min": [0, 0, 0], "max": [1, 1, 1] }
      })),
      "material.import" => Ok(json!({ "materials": [{ "id": "m1", "name": "Oak", "reused": false }] })),
      "texture.add" => Ok(json!({ "id": "t1", "name": "wood.png" })),
      other => Err(format!("Unknown command \"{other}\"")),
    }
  }
}

impl Frontend for Mock {
  fn command_id(&self, tool: &str) -> Option<String> {
    self.tools.iter().any(|known| known == tool).then(|| tool.replacen('_', ".", 1))
  }

  fn is_ready(&self) -> bool {
    !self.tools.is_empty()
  }

  async fn call(&self, command: &str, params: Value, _timeout: Duration) -> Reply {
    let number = {
      let mut calls = self.calls.lock().unwrap();
      calls.push((command.to_string(), params.clone()));
      calls.len()
    };
    self.reply(command, &params, number)
  }
}

pub fn block_on<T>(future: impl Future<Output = T>) -> T {
  tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(future)
}

/// Calls a tool the way the MCP server does.
pub fn call(mock: &Mock, tool: &str, args: Value) -> ToolOutput {
  block_on(tools::call(mock, tool, args))
}

/// The error text of a failed call.
pub fn error_of(output: &ToolOutput) -> String {
  assert!(output.is_error, "expected an error, got {}", output.value);
  match &output.value {
    Value::String(message) => message.clone(),
    other => other.to_string(),
  }
}

/// A fresh, empty folder for one test.
pub struct TempDir(pub PathBuf);

impl TempDir {
  pub fn new(name: &str) -> Self {
    let path = std::env::temp_dir().join(format!("tessel-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    Self(path)
  }

  /// Writes a file and returns its absolute path.
  pub fn file(&self, name: &str, contents: impl AsRef<[u8]>) -> String {
    let path = self.0.join(name);
    std::fs::write(&path, contents).unwrap();
    path.to_string_lossy().into_owned()
  }

  pub fn path(&self, name: &str) -> String {
    self.0.join(name).to_string_lossy().into_owned()
  }
}

impl Drop for TempDir {
  fn drop(&mut self) {
    let _ = std::fs::remove_dir_all(&self.0);
  }
}
