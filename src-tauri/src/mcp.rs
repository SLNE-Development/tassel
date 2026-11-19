//! The embedded MCP server: Streamable HTTP on 127.0.0.1, served by rmcp behind an axum router.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

use axum::Router;
use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use rmcp::ErrorData;
use rmcp::ServerHandler;
use rmcp::model::{
  CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation, JsonObject, ListToolsResult,
  PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use serde_json::{Value, json};

use crate::bridge::Bridge;
use crate::tools::{self, ToolOutput};

pub const PORT: u16 = 4737;
const PATH: &str = "/mcp";

const INSTRUCTIONS: &str = "Tessel is a desktop 3D editor for polygon modeling; this server controls the running editor \
window, so the user sees every change you make live. Start with app_get_state to learn which documents are open, \
what is selected and where the camera is. Every editor action is a tool (scene_*, mesh_*, uv_*, material_*, \
texture_*, group_*, modifier_*, view_*, document_*, history_*), and each change is one undo step. \
Conventions: Y is up, units are meters, rotations are Euler XYZ in degrees. View presets are named after where \
the camera stands: front = camera on +Z looking towards -Z, back = on -Z, right = on +X, left = on -X, top = on +Y \
looking down, bottom = on -Y. Call view_screenshot to see the result of your work. \
Use render_image for presentation-quality pictures (path traced, takes seconds to minutes) and view_screenshot \
for quick checks. \
To show a process as a video: animate with the anim_* tools (anim_add_motion, anim_follow_path, anim_camera_orbit, \
anim_set_key), check the timing with anim_evaluate and view_screenshot { frame }, then write the file with \
render_video { path }. \
Building anything bigger than a few objects: do NOT call tools one by one. Write a script that generates a JSON \
file with all commands [{ \"tool\", \"params\", \"as\" }, ...] and run it with batch { \"file\": \"<absolute path>.json\" } \
(hundreds of commands per second, nothing travels through the conversation). Inside a batch, label a command with \
\"as\": \"name\" and use \"$name\" (its result's id), \"$name.field.0.id\", \"$<index>\" or \"$prev\" in the params of \
later commands instead of copying ids. For big files run batch with validateOnly: true first; resultMode \"ids\" or \
\"summary\" keeps the answer small; end the batch with view_screenshot to get a picture back. \
Wherever a tool takes an object, group or material id you can also pass its name, or for objects a glob such as \
\"Leg*\" (* and ?, case-sensitive); a single-object parameter must match exactly one. \
The user can switch tabs at any time. To keep working on your model regardless of what the user looks at, take \
your document's id once (from document_new, file_open, document_list or app_get_state) and pass it as documentId \
on every call, including view_screenshot and batch: the call then runs against that open document without \
switching the visible tab, view_screenshot renders it off-screen, and the view_* camera tools move its own \
remembered camera, not the user's. Use activate: false when creating or opening a document (document_new, \
file_open) so you do not pull the user away from what they are looking at. Calls without documentId act on \
whatever tab is visible at that moment. Only view_set_tool and view_set_shading, which change what the user \
sees, refuse a document in the background (view_screenshot has its own shading option). \
Files (absolute paths): file_save / file_open for .tessel project files; file_export writes .glb, .gltf, .obj \
(+ .mtl and textures), .stl, .ply or .usdz; file_import reads .glb, .gltf, .obj, .stl, .ply or .fbx models and \
.png / .jpg / .webp images as textures; scene_place_model puts a model file (also a .tessel project) into the \
scene as one group at a position; material_import copies materials from another .tessel project. Prefer these \
file tools over export_file / import_file / texture_get, which pass whole files through the conversation. \
Team projects: project_list shows the project folders (git repositories, e.g. one per Minecraft server); \
project_files lists their model files, project_open / project_save open and save .tessel documents by a path \
relative to the project, and git_status, git_commit, git_pull, git_push, git_branches and git_switch_branch share \
the work with the team through the GitHub account signed in to Tessel.";

pub fn url() -> String {
  format!("http://127.0.0.1:{PORT}{PATH}")
}

/// Binds the port and serves MCP in the background. Never fails: a bind error ends up in `mcp_status`.
pub fn start(bridge: Arc<Bridge>, token: String) {
  let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, PORT));
  let listener = std::net::TcpListener::bind(addr).and_then(|listener| {
    listener.set_nonblocking(true)?;
    Ok(listener)
  });
  let listener = match listener {
    Ok(listener) => listener,
    Err(e) => {
      let message = format!("Could not start the MCP server on {addr}: {e}");
      log::error!("{message}");
      bridge.set_status(false, Some(message));
      return;
    }
  };
  bridge.set_status(true, None);
  log::info!("MCP server listening on {}", url());

  tauri::async_runtime::spawn(async move {
    let result = match tokio::net::TcpListener::from_std(listener) {
      Ok(listener) => axum::serve(listener, router(bridge.clone(), token)).await,
      Err(e) => Err(e),
    };
    let message = match result {
      Ok(()) => "The MCP server stopped".to_string(),
      Err(e) => format!("The MCP server stopped: {e}"),
    };
    log::error!("{message}");
    bridge.set_status(false, Some(message));
  });
}

fn router(bridge: Arc<Bridge>, token: String) -> Router {
  // Stateless with plain JSON responses: every POST is answered directly, no session to keep alive.
  // rmcp additionally rejects requests whose Host header is not a loopback name.
  let config = StreamableHttpServerConfig::default()
    .with_legacy_session_mode(false)
    .with_json_response(true);
  let service = StreamableHttpService::new(
    move || Ok(TesselServer { bridge: bridge.clone() }),
    Arc::new(LocalSessionManager::default()),
    config,
  );
  Router::new()
    .route_service(PATH, service)
    .layer(middleware::from_fn_with_state(Arc::<str>::from(token), require_token))
    .layer(middleware::from_fn(reject_foreign_origins))
}

/// Loads the access token from `path`, or creates and stores a new one on first launch. The token
/// is kept across launches so MCP client configurations stay valid.
pub fn load_or_create_token(path: &std::path::Path) -> std::io::Result<String> {
  if let Ok(existing) = std::fs::read_to_string(path) {
    let existing = existing.trim();
    if existing.len() == 64 && existing.bytes().all(|b| b.is_ascii_hexdigit()) {
      return Ok(existing.to_string());
    }
  }
  let mut bytes = [0u8; 32];
  getrandom::fill(&mut bytes).map_err(|e| std::io::Error::other(e.to_string()))?;
  let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent)?;
  }
  std::fs::write(path, &token)?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
  }
  Ok(token)
}

/// Every request must carry `Authorization: Bearer <token>`: the tools read and write files, so
/// other local processes must not be able to use the server without the user handing them the token.
async fn require_token(State(token): State<Arc<str>>, request: Request, next: Next) -> Response {
  let given = request
    .headers()
    .get(header::AUTHORIZATION)
    .and_then(|value| value.to_str().ok())
    .and_then(|value| value.strip_prefix("Bearer "));
  if !given.is_some_and(|given| constant_time_eq(given.as_bytes(), token.as_bytes())) {
    return (
      StatusCode::UNAUTHORIZED,
      [(header::WWW_AUTHENTICATE, "Bearer")],
      "Unauthorized: missing or wrong access token",
    )
      .into_response();
  }
  next.run(request).await
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
  a.len() == b.len() && a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

/// DNS-rebinding protection: browsers always send `Origin` on cross-site requests, so a present
/// Origin must be the app itself or another local page. Requests without Origin (CLI clients) pass.
async fn reject_foreign_origins(request: Request, next: Next) -> Response {
  if let Some(origin) = request.headers().get(header::ORIGIN) {
    let allowed = origin.to_str().is_ok_and(is_local_origin);
    if !allowed {
      log::warn!("MCP: rejected request with Origin {origin:?}");
      return (StatusCode::FORBIDDEN, "Forbidden: Origin is not allowed").into_response();
    }
  }
  next.run(request).await
}

fn is_local_origin(origin: &str) -> bool {
  let Some((scheme, authority)) = origin.split_once("://") else {
    return false;
  };
  if authority.contains(['/', '@', '?', '#']) {
    return false;
  }
  let host = if let Some(rest) = authority.strip_prefix('[') {
    // IPv6 literal: [::1] or [::1]:port
    match rest.split_once(']') {
      Some((host, port)) if port.is_empty() || is_port(port.strip_prefix(':')) => host,
      _ => return false,
    }
  } else {
    match authority.rsplit_once(':') {
      Some((host, port)) if is_port(Some(port)) => host,
      Some(_) => return false,
      None => authority,
    }
  };
  let host = host.to_ascii_lowercase();
  match scheme.to_ascii_lowercase().as_str() {
    "tauri" => host == "localhost",
    "http" | "https" => matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1" | "tauri.localhost"),
    _ => false,
  }
}

fn is_port(port: Option<&str>) -> bool {
  port.is_some_and(|p| !p.is_empty() && p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit()))
}

struct TesselServer {
  bridge: Arc<Bridge>,
}

impl TesselServer {
  fn tools(&self) -> Vec<Tool> {
    let native = tools::native_tools();
    let mut list: Vec<Tool> = self
      .bridge
      .commands()
      .into_iter()
      // A native tool wins over a frontend command of the same name.
      .filter(|command| native.iter().all(|n| n.name != command.name))
      .map(|command| Tool::new(command.name, command.description, schema_object(command.input_schema)))
      .collect();
    list.extend(
      native
        .into_iter()
        .map(|tool| Tool::new(tool.name, tool.description, schema_object(tool.input_schema))),
    );
    list
  }
}

fn schema_object(schema: Value) -> JsonObject {
  match schema {
    Value::Object(mut object) => {
      object.entry("type").or_insert_with(|| json!("object"));
      object
    }
    _ => json!({ "type": "object" }).as_object().cloned().unwrap_or_default(),
  }
}

impl ServerHandler for TesselServer {
  fn get_info(&self) -> ServerConfig {
    ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
      .with_server_info(
        Implementation::new("tessel", env!("CARGO_PKG_VERSION"))
          .with_title("Tessel")
          .with_description("Tessel 3D editor"),
      )
      .with_instructions(INSTRUCTIONS)
  }

  async fn list_tools(
    &self,
    _request: Option<PaginatedRequestParams>,
    _context: RequestContext<RoleServer>,
  ) -> Result<ListToolsResult, ErrorData> {
    Ok(ListToolsResult::with_all_items(self.tools()))
  }

  async fn call_tool(
    &self,
    request: CallToolRequestParams,
    _context: RequestContext<RoleServer>,
  ) -> Result<CallToolResponse, ErrorData> {
    let args = Value::Object(request.arguments.unwrap_or_default());
    let output = tools::call(self.bridge.as_ref(), &request.name, args).await;
    Ok(to_result(output).into())
  }
}

/// Tool output → MCP content. `{ image: { mimeType, base64 }, ... }` becomes image content, with any
/// remaining fields as text; a batch brings the images of its calls along separately.
fn to_result(output: ToolOutput) -> CallToolResult {
  let ToolOutput { mut value, is_error, mut images } = output;

  if images.is_empty()
    && let Some(image) = tools::take_image(&mut value)
  {
    images.push(image);
    if value.as_object().is_some_and(|rest| rest.is_empty()) {
      value = Value::Null;
    }
  }

  let mut content = Vec::new();
  match value {
    Value::Null => {}
    Value::String(text) => content.push(ContentBlock::text(text)),
    other => content.push(ContentBlock::text(other.to_string())),
  }
  content.extend(images.into_iter().map(|(base64, mime_type)| ContentBlock::image(base64, mime_type)));
  if content.is_empty() {
    content.push(ContentBlock::text("null"));
  }

  if is_error { CallToolResult::error(content) } else { CallToolResult::success(content) }
}

#[cfg(test)]
mod tests {
  use serde_json::json;

  use super::{is_local_origin, to_result};
  use crate::tools::ToolOutput;

  #[test]
  fn images_become_image_content() {
    let image = |data: &str| (data.to_string(), "image/png".to_string());
    // A single screenshot: only the image.
    let single = ToolOutput { value: json!({ "image": { "mimeType": "image/png", "base64": "AAAA" } }), is_error: false, images: vec![] };
    let result = serde_json::to_value(to_result(single)).unwrap();
    assert_eq!(result["content"].as_array().unwrap().len(), 1);
    assert_eq!(result["content"][0]["type"], "image");
    assert_eq!(result["content"][0]["data"], "AAAA");
    // A batch: its JSON as text, then the images in order.
    let batch = ToolOutput { value: json!({ "completed": 2 }), is_error: true, images: vec![image("AAAA"), image("BBBB")] };
    let result = serde_json::to_value(to_result(batch)).unwrap();
    let content = result["content"].as_array().unwrap();
    assert_eq!(content.len(), 3);
    assert_eq!(content[0]["type"], "text");
    assert_eq!(content[0]["text"], "{\"completed\":2}");
    assert_eq!(content[2]["data"], "BBBB");
    assert_eq!(result["isError"], true);
    let nothing = serde_json::to_value(to_result(ToolOutput { value: json!(null), is_error: false, images: vec![] })).unwrap();
    assert_eq!(nothing["content"][0]["text"], "null");
  }

  #[test]
  fn origins() {
    for ok in [
      "http://localhost",
      "http://localhost:5173",
      "https://127.0.0.1:4737",
      "http://[::1]:8080",
      "tauri://localhost",
      "http://tauri.localhost",
      "https://tauri.localhost",
    ] {
      assert!(is_local_origin(ok), "{ok}");
    }
    for bad in [
      "null",
      "https://evil.example",
      "http://localhost.evil.example",
      "http://evil.example:4737",
      "http://127.0.0.1.evil.example",
      "http://user@localhost",
      "file://localhost",
      "http://localhost:abc",
    ] {
      assert!(!is_local_origin(bad), "{bad}");
    }
  }
}
