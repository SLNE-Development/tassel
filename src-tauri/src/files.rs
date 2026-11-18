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

#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
  read_text(&path).await
}

#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> Result<(), String> {
  write_bytes(&path, contents.as_bytes()).await
}

#[tauri::command]
pub async fn write_binary_file(path: String, base64: String) -> Result<(), String> {
  write_bytes(&path, &decode_base64(&base64)?).await
}
