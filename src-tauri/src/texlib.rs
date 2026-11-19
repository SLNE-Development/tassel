//! Texture library: resource-pack textures (`assets/<namespace>/textures/**.png`) in projects and in
//! extra library folders the user adds.
//!
//! A *source* is addressed by a key: `project:<id>` for a registered project or `folder:<id>` for a
//! library folder (remembered in `texture_libraries.json` in the app config folder). Every path is
//! relative to the source root and goes through `projects::resolve`, so nothing outside the root can
//! be read or written. Only `.png` files and their `.png.mcmeta` animation files are touched here.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::files;
use crate::projects::{self, Entry, Project, Registry};
use crate::workspace::Workspace;

/// Largest `.mcmeta` that is sent along with a scan (they are a few hundred bytes in practice).
const MAX_MCMETA_BYTES: u64 = 64 * 1024;

/// The extra library folders.
pub struct Libraries {
  pub folders: Registry,
}

static GLOBAL: OnceLock<Arc<Libraries>> = OnceLock::new();

impl Libraries {
  pub fn load(config_dir: &Path) -> Self {
    Self { folders: Registry::load(config_dir.join("texture_libraries.json")) }
  }
}

pub fn init(config_dir: &Path) -> Arc<Libraries> {
  let libraries = Arc::new(Libraries::load(config_dir));
  let _ = GLOBAL.set(libraries.clone());
  libraries
}

/// A library folder as the webview sees it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFolder {
  /// Source key, `folder:<id>`.
  pub source: String,
  pub id: String,
  pub name: String,
  pub path: String,
  pub exists: bool,
}

fn folder_info(project: Project) -> LibraryFolder {
  LibraryFolder {
    source: format!("folder:{}", project.id),
    exists: Path::new(&project.path).is_dir(),
    id: project.id,
    name: project.name,
    path: project.path,
  }
}

/// One texture file of a source.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextureFile {
  /// Relative to the source root, `/`-separated, e.g. `assets/surf/textures/block/stone.png`.
  pub file: String,
  pub namespace: String,
  /// Below `textures/`, without `.png`, e.g. `block/stone`.
  pub path: String,
  pub size: u64,
  pub modified: u64,
  /// From the PNG header; 0 when it cannot be read.
  pub width: u32,
  pub height: u32,
  /// The `.png.mcmeta` next to it, as text.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub mcmeta: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
  /// The folder that holds the namespaces relative to the root: `assets`, or `` when the root is
  /// itself an assets folder.
  pub assets: String,
  pub textures: Vec<TextureFile>,
  /// True if the listing was cut off at `projects::MAX_LISTED_ENTRIES` files.
  pub truncated: bool,
}

/// Width and height from a PNG's IHDR chunk.
pub fn png_size(header: &[u8]) -> Option<(u32, u32)> {
  const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
  if header.len() < 24 || header[..8] != SIGNATURE || &header[12..16] != b"IHDR" {
    return None;
  }
  let width = u32::from_be_bytes(header[16..20].try_into().ok()?);
  let height = u32::from_be_bytes(header[20..24].try_into().ok()?);
  Some((width, height))
}

fn read_header(path: &Path) -> Option<(u32, u32)> {
  let mut buffer = [0u8; 24];
  let mut file = std::fs::File::open(path).ok()?;
  file.read_exact(&mut buffer).ok()?;
  png_size(&buffer)
}

/// `assets` if the root has such a folder, otherwise `` (the root is taken to be an assets folder).
pub fn assets_dir(root: &Path) -> String {
  if root.join("assets").is_dir() { "assets".into() } else { String::new() }
}

/// Splits `<assets>/<namespace>/textures/<path>.png` into namespace and path.
pub fn texture_location(assets: &str, file: &str) -> Option<(String, String)> {
  let rest = if assets.is_empty() { file } else { file.strip_prefix(assets)?.strip_prefix('/')? };
  let (namespace, rest) = rest.split_once('/')?;
  let path = rest.strip_prefix("textures/")?;
  let path = path.strip_suffix(".png")?;
  if namespace.is_empty() || path.is_empty() {
    return None;
  }
  Some((namespace.to_string(), path.to_string()))
}

/// Every texture of a source root.
pub fn scan(root: &Path) -> Result<Scan, String> {
  let assets = assets_dir(root);
  let (entries, truncated) = projects::list_files(root, &assets)?;
  let mcmeta: std::collections::HashSet<&str> =
    entries.iter().filter_map(|e| e.path.strip_suffix(".mcmeta")).filter(|p| p.ends_with(".png")).collect();
  let mut textures = Vec::new();
  for entry in &entries {
    let Some((namespace, path)) = texture_location(&assets, &entry.path) else { continue };
    let absolute = projects::resolve(root, &entry.path)?;
    let (width, height) = read_header(&absolute).unwrap_or((0, 0));
    let meta = if mcmeta.contains(entry.path.as_str()) {
      let meta_path = absolute.with_file_name(format!("{}.mcmeta", entry.name));
      std::fs::metadata(&meta_path)
        .ok()
        .filter(|m| m.len() <= MAX_MCMETA_BYTES)
        .and_then(|_| std::fs::read(&meta_path).ok())
        .and_then(|bytes| files::decode_text(&bytes).ok())
    } else {
      None
    };
    textures.push(TextureFile { file: entry.path.clone(), namespace, path, size: entry.size, modified: entry.modified, width, height, mcmeta: meta });
  }
  Ok(Scan { assets, textures, truncated })
}

/// Only texture files (and their animation files) below a `textures` folder may be written or moved.
pub fn require_texture_file(relative: &str) -> Result<(), String> {
  let parts = projects::relative_components(relative)?;
  let name = parts.last().map(String::as_str).unwrap_or("");
  let lower = name.to_ascii_lowercase();
  if !(lower.ends_with(".png") || lower.ends_with(".png.mcmeta")) {
    return Err(format!("\"{relative}\" is not a .png texture or its .png.mcmeta"));
  }
  if !parts.iter().any(|p| p == "textures") {
    return Err(format!("\"{relative}\" is not inside a textures folder"));
  }
  Ok(())
}

/// Last change of each file in milliseconds since 1970, or None if it is missing.
pub fn stat(root: &Path, files: &[String]) -> Vec<Option<u64>> {
  files
    .iter()
    .map(|file| {
      let path = projects::resolve(root, file).ok()?;
      let meta = std::fs::metadata(path).ok().filter(|m| m.is_file())?;
      meta.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
    })
    .collect()
}

/// Moves a texture and its `.mcmeta` (if any). The target must not exist.
pub fn move_texture(root: &Path, from: &str, to: &str) -> Result<(), String> {
  require_texture_file(from)?;
  require_texture_file(to)?;
  projects::rename(root, from, to)?;
  let meta_from = format!("{from}.mcmeta");
  if projects::resolve(root, &meta_from)?.is_file() {
    projects::rename(root, &meta_from, &format!("{to}.mcmeta"))?;
  }
  Ok(())
}

/// The root folder of a source key.
pub fn source_root(workspace: &Workspace, libraries: &Libraries, source: &str) -> Result<PathBuf, String> {
  let (path, label) = if let Some(id) = source.strip_prefix("project:") {
    let project = workspace.project(id)?;
    (project.path, project.name)
  } else if let Some(id) = source.strip_prefix("folder:") {
    let folder = libraries.folders.find(id).map_err(|_| format!("There is no texture library folder \"{id}\""))?;
    (folder.path, folder.name)
  } else {
    return Err(format!("\"{source}\" is not a texture library source (expected project:<id> or folder:<id>)"));
  };
  let root = PathBuf::from(&path);
  if !root.is_dir() {
    return Err(format!("The folder of \"{label}\" is missing: {path}"));
  }
  Ok(root)
}

// ---- webview commands ----------------------------------------------------------------------------

type Ws<'a> = State<'a, Arc<Workspace>>;
type Libs<'a> = State<'a, Arc<Libraries>>;

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tokio::task::spawn_blocking(work).await.map_err(|e| format!("The operation was interrupted: {e}"))?
}

#[tauri::command]
pub fn texlib_folders(libs: Libs<'_>) -> Vec<LibraryFolder> {
  libs.folders.list().into_iter().map(folder_info).collect()
}

#[tauri::command]
pub fn texlib_add_folder(libs: Libs<'_>, path: String, name: Option<String>) -> Result<LibraryFolder, String> {
  libs.folders.add(&path, name.as_deref(), None).map(folder_info)
}

#[tauri::command]
pub fn texlib_remove_folder(libs: Libs<'_>, id: String) -> Result<(), String> {
  libs.folders.remove(id.strip_prefix("folder:").unwrap_or(&id))
}

#[tauri::command]
pub async fn texlib_scan(ws: Ws<'_>, libs: Libs<'_>, source: String) -> Result<Scan, String> {
  let root = source_root(&ws, &libs, &source)?;
  blocking(move || scan(&root)).await
}

#[tauri::command]
pub async fn texlib_read(ws: Ws<'_>, libs: Libs<'_>, source: String, file: String) -> Result<String, String> {
  let root = source_root(&ws, &libs, &source)?;
  Ok(files::encode_base64(&projects::read_bytes(&root, &file).await?))
}

#[tauri::command]
pub async fn texlib_read_text(ws: Ws<'_>, libs: Libs<'_>, source: String, file: String) -> Result<String, String> {
  let root = source_root(&ws, &libs, &source)?;
  projects::read_text(&root, &file).await
}

/// Writes a texture (or its .mcmeta); `base64: None` with `text` writes text. Returns the new modification time.
#[tauri::command]
pub async fn texlib_write(
  ws: Ws<'_>,
  libs: Libs<'_>,
  source: String,
  file: String,
  base64: Option<String>,
  text: Option<String>,
) -> Result<u64, String> {
  let root = source_root(&ws, &libs, &source)?;
  require_texture_file(&file)?;
  let bytes = match (base64, text) {
    (Some(data), _) => files::decode_base64(&data)?,
    (None, Some(text)) => text.into_bytes(),
    (None, None) => return Err("Nothing to write".into()),
  };
  projects::write_bytes(&root, &file, &bytes).await?;
  Ok(stat(&root, &[file])[0].unwrap_or(0))
}

/// Moves a texture to the trash.
#[tauri::command]
pub fn texlib_trash(ws: Ws<'_>, libs: Libs<'_>, source: String, file: String) -> Result<(), String> {
  let root = source_root(&ws, &libs, &source)?;
  require_texture_file(&file)?;
  projects::delete(&root, &file)
}

#[tauri::command]
pub fn texlib_move(ws: Ws<'_>, libs: Libs<'_>, source: String, from: String, to: String) -> Result<(), String> {
  let root = source_root(&ws, &libs, &source)?;
  move_texture(&root, &from, &to)
}

#[tauri::command]
pub fn texlib_stat(ws: Ws<'_>, libs: Libs<'_>, source: String, files: Vec<String>) -> Result<Vec<Option<u64>>, String> {
  let root = source_root(&ws, &libs, &source)?;
  Ok(stat(&root, &files))
}

/// Every project file below `dir` (for rewriting references after a move).
#[tauri::command]
pub async fn texlib_list_files(ws: Ws<'_>, libs: Libs<'_>, source: String, dir: String) -> Result<Vec<Entry>, String> {
  let root = source_root(&ws, &libs, &source)?;
  blocking(move || {
    if !projects::resolve(&root, &dir)?.is_dir() {
      return Ok(Vec::new());
    }
    projects::list_files(&root, &dir).map(|(entries, _)| entries)
  })
  .await
}

#[tauri::command]
pub fn texlib_reveal(app: AppHandle, ws: Ws<'_>, libs: Libs<'_>, source: String, file: Option<String>) -> Result<(), String> {
  let root = source_root(&ws, &libs, &source)?;
  let target = projects::resolve(&root, file.as_deref().unwrap_or(""))?;
  app.opener().reveal_item_in_dir(&target).map_err(|e| format!("Could not show the file: {e}"))
}

#[cfg(test)]
#[path = "texlib_tests.rs"]
mod tests;
