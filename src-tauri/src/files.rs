//! File access for the UI's own open/save/export flows (`src/bridge/files.ts`) and the native MCP tools.

use std::path::Path;

use base64::Engine;

pub async fn read_text(path: &str) -> Result<String, String> {
  tokio::fs::read_to_string(path)
    .await
    .map_err(|e| format!("Could not read \"{path}\": {e}"))
}

/// Writes a file, creating parent directories as needed.
pub async fn write_bytes(path: &str, bytes: &[u8]) -> Result<(), String> {
  if let Some(parent) = Path::new(path).parent()
    && !parent.as_os_str().is_empty()
  {
    tokio::fs::create_dir_all(parent)
      .await
      .map_err(|e| format!("Could not create folder \"{}\": {e}", parent.display()))?;
  }
  tokio::fs::write(path, bytes)
    .await
    .map_err(|e| format!("Could not write \"{path}\": {e}"))
}

pub fn decode_base64(data: &str) -> Result<Vec<u8>, String> {
  base64::engine::general_purpose::STANDARD
    .decode(data.trim())
    .map_err(|e| format!("Invalid base64 data: {e}"))
}

/// Lower-case file extension without the dot, or an empty string.
pub fn extension(path: &str) -> String {
  Path::new(path)
    .extension()
    .map(|e| e.to_string_lossy().to_ascii_lowercase())
    .unwrap_or_default()
}

/// The webview may only touch the file types the editor works with, whatever path it is handed
/// (a document's file path can be set through MCP).
fn require_extension(path: &str, allowed: &[&str]) -> Result<(), String> {
  if allowed.contains(&extension(path).as_str()) {
    Ok(())
  } else {
    Err(format!("\"{path}\" must end in .{}", allowed.join(" or .")))
  }
}

#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
  require_extension(&path, &["tessel"])?;
  read_text(&path).await
}

#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> Result<(), String> {
  require_extension(&path, &["tessel", "gltf"])?;
  write_bytes(&path, contents.as_bytes()).await
}

#[tauri::command]
pub async fn write_binary_file(path: String, base64: String) -> Result<(), String> {
  require_extension(&path, &["glb"])?;
  write_bytes(&path, &decode_base64(&base64)?).await
}
