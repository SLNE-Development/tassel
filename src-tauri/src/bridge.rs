//! The link between the MCP server and the frontend's command system.
//!
//! The frontend registers its commands once at startup (`mcp_register_commands`). To run one,
//! we emit `mcp://call` to the main webview and wait for `mcp_respond` with the same request id.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

pub const MAIN_WINDOW: &str = "main";
pub const CALL_EVENT: &str = "mcp://call";
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// A frontend command as exposed to MCP clients.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendCommand {
  /// MCP tool name, e.g. `scene_add_primitive`.
  pub name: String,
  /// Command id in the frontend, e.g. `scene.add_primitive`.
  pub id: Option<String>,
  #[serde(default)]
  pub description: String,
  /// JSON Schema of the parameters.
  #[serde(default)]
  pub input_schema: Value,
}

impl FrontendCommand {
  pub fn command_id(&self) -> String {
    self.id.clone().unwrap_or_else(|| self.name.replacen('_', ".", 1))
  }
}

#[derive(Debug, Clone, Serialize)]
pub struct McpStatus {
  pub running: bool,
  pub url: String,
  pub error: Option<String>,
}

type Reply = Result<Value, String>;

pub struct Bridge {
  app: AppHandle,
  commands: RwLock<Vec<FrontendCommand>>,
  pending: Mutex<HashMap<String, oneshot::Sender<Reply>>>,
  next_id: AtomicU64,
  status: RwLock<McpStatus>,
}

impl Bridge {
  pub fn new(app: AppHandle) -> Self {
    Self {
      app,
      commands: RwLock::new(Vec::new()),
      pending: Mutex::new(HashMap::new()),
      next_id: AtomicU64::new(1),
      status: RwLock::new(McpStatus { running: false, url: crate::mcp::url(), error: None }),
    }
  }

  pub fn commands(&self) -> Vec<FrontendCommand> {
    self.commands.read().unwrap().clone()
  }

  pub fn find_command(&self, tool: &str) -> Option<FrontendCommand> {
    self.commands.read().unwrap().iter().find(|c| c.name == tool).cloned()
  }

  pub fn set_status(&self, running: bool, error: Option<String>) {
    let mut status = self.status.write().unwrap();
    status.running = running;
    status.error = error;
  }

  /// Runs a frontend command by its dotted id and waits for the result.
  pub async fn call(&self, command: &str, params: Value) -> Reply {
    if self.commands.read().unwrap().is_empty() {
      return Err(
        "The Forma editor window has not finished starting (no commands registered yet). Try again in a moment."
          .into(),
      );
    }
    let Some(window) = self.app.get_webview_window(MAIN_WINDOW) else {
      return Err("The Forma editor window is not open.".into());
    };

    let request_id = format!("mcp-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
    let (tx, rx) = oneshot::channel();
    self.pending.lock().unwrap().insert(request_id.clone(), tx);

    let payload = json!({ "requestId": request_id, "command": command, "params": params });
    if let Err(e) = window.emit_to(MAIN_WINDOW, CALL_EVENT, payload) {
      self.pending.lock().unwrap().remove(&request_id);
      return Err(format!("Could not reach the Forma editor window: {e}"));
    }

    match tokio::time::timeout(CALL_TIMEOUT, rx).await {
      Ok(Ok(reply)) => reply,
      Ok(Err(_)) => Err(format!("The editor dropped the request for \"{command}\".")),
      Err(_) => {
        self.pending.lock().unwrap().remove(&request_id);
        Err(format!(
          "The editor did not answer \"{command}\" within {} seconds.",
          CALL_TIMEOUT.as_secs()
        ))
      }
    }
  }

  fn respond(&self, request_id: &str, reply: Reply) -> Result<(), String> {
    let sender = self.pending.lock().unwrap().remove(request_id);
    match sender {
      // A send error only means the MCP request was cancelled in the meantime.
      Some(tx) => {
        let _ = tx.send(reply);
        Ok(())
      }
      None => Err(format!("No pending MCP request \"{request_id}\" (it may have timed out)")),
    }
  }
}

#[tauri::command]
pub fn mcp_register_commands(bridge: State<'_, Arc<Bridge>>, commands: Vec<FrontendCommand>) -> usize {
  let count = commands.len();
  *bridge.commands.write().unwrap() = commands;
  log::info!("MCP: {count} frontend commands registered");
  count
}

#[tauri::command]
pub fn mcp_respond(
  bridge: State<'_, Arc<Bridge>>,
  request_id: String,
  ok: bool,
  result: Option<Value>,
  error: Option<String>,
) -> Result<(), String> {
  let reply = if ok {
    Ok(result.unwrap_or(Value::Null))
  } else {
    Err(error.unwrap_or_else(|| "Unknown error".into()))
  };
  bridge.respond(&request_id, reply)
}

#[tauri::command]
pub fn mcp_status(bridge: State<'_, Arc<Bridge>>) -> McpStatus {
  bridge.status.read().unwrap().clone()
}
