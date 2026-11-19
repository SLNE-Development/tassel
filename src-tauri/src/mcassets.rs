//! A read-only source of Minecraft assets (textures, models) taken from the user's own install: a
//! folder (resource pack or extracted jar) or a `.jar`/`.zip` archive. Nothing is bundled, and reads
//! are only possible through the one source the user opened.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;
use zip::ZipArchive;

/// The largest single file that will be read.
const MAX_ENTRY_BYTES: u64 = 32 * 1024 * 1024;
/// The most paths `list` returns.
const MAX_LISTED: usize = 50_000;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
  pub path: String,
  /// `"folder"` or `"jar"`.
  pub kind: String,
  pub namespaces: Vec<String>,
  pub pack_format: Option<u32>,
  pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Install {
  pub version: String,
  pub path: String,
  /// Unix seconds.
  pub modified: u64,
}

enum Backing {
  Folder(PathBuf),
  Jar(ZipArchive<File>),
}

pub struct Source {
  backing: Backing,
  info: SourceInfo,
}

/// Checks that `rel` is a plain forward-slash path that may be read: under `assets/`, or one of the
/// two pack files.
fn validate(rel: &str) -> Result<(), String> {
  if rel != "pack.mcmeta" && rel != "pack.png" && !rel.starts_with("assets/") {
    return Err(format!("path \"{rel}\" is outside assets/"));
  }
  check_components(rel)
}

fn check_components(rel: &str) -> Result<(), String> {
  if rel.contains('\\') || rel.contains(':') || rel.contains('\0') {
    return Err(format!("invalid path \"{rel}\""));
  }
  if rel.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
    return Err(format!("invalid path \"{rel}\""));
  }
  Ok(())
}

fn read_limited(reader: impl Read, size_hint: u64) -> Result<Vec<u8>, String> {
  if size_hint > MAX_ENTRY_BYTES {
    return Err("file is too large".into());
  }
  let mut bytes = Vec::new();
  reader.take(MAX_ENTRY_BYTES + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
  if bytes.len() as u64 > MAX_ENTRY_BYTES {
    return Err("file is too large".into());
  }
  Ok(bytes)
}

fn dir_names(dir: &Path) -> Vec<String> {
  let mut names: Vec<String> = fs::read_dir(dir)
    .map(|entries| {
      entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect()
    })
    .unwrap_or_default();
  names.sort();
  names
}

/// Pulls the resource pack format and version name out of `pack.mcmeta` / `version.json` contents.
fn parse_meta(pack_mcmeta: Option<&[u8]>, version_json: Option<&[u8]>) -> (Option<u32>, Option<String>) {
  let json = |bytes: Option<&[u8]>| bytes.and_then(|b| serde_json::from_slice::<Value>(b).ok());
  let mut pack_format = json(pack_mcmeta)
    .and_then(|v| v.pointer("/pack/pack_format").and_then(Value::as_u64))
    .map(|n| n as u32);
  let mut version = None;
  if let Some(v) = json(version_json) {
    if pack_format.is_none() {
      let pv = v.get("pack_version");
      pack_format = pv
        .and_then(|p| p.get("resource").and_then(Value::as_u64).or_else(|| p.as_u64()))
        .map(|n| n as u32);
    }
    version = ["name", "id"].iter().find_map(|k| v.get(k).and_then(Value::as_str)).map(String::from);
  }
  (pack_format, version)
}

impl Source {
  pub fn open(path: &Path) -> Result<Source, String> {
    if path.is_dir() {
      Self::open_folder(path)
    } else if path.is_file() {
      let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
      if ext != "jar" && ext != "zip" {
        return Err("expected a folder, .jar or .zip".into());
      }
      Self::open_jar(path)
    } else {
      Err(format!("{} does not exist", path.display()))
    }
  }

  fn open_folder(path: &Path) -> Result<Source, String> {
    let root = if path.join("assets").is_dir() {
      path.to_path_buf()
    } else if path.file_name().is_some_and(|n| n == "assets") {
      path.parent().ok_or("assets folder has no parent")?.to_path_buf()
    } else {
      return Err("folder has no assets directory".into());
    };
    let namespaces = dir_names(&root.join("assets"));
    let read = |name: &str| fs::read(root.join(name)).ok();
    let (pack_format, version) = parse_meta(read("pack.mcmeta").as_deref(), read("version.json").as_deref());
    let info = SourceInfo { path: root.to_string_lossy().into_owned(), kind: "folder".into(), namespaces, pack_format, version };
    Ok(Source { backing: Backing::Folder(root), info })
  }

  fn open_jar(path: &Path) -> Result<Source, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut zip = ZipArchive::new(file).map_err(|e| format!("not a valid archive: {e}"))?;
    let mut namespaces: Vec<String> = Vec::new();
    for name in zip.file_names() {
      if let Some((ns, _)) = name.strip_prefix("assets/").and_then(|rest| rest.split_once('/'))
        && !ns.is_empty()
        && !namespaces.iter().any(|n| n == ns)
      {
        namespaces.push(ns.to_string());
      }
    }
    if namespaces.is_empty() {
      return Err("archive has no assets/ entries".into());
    }
    namespaces.sort();
    let mut entry = |name: &str| -> Option<Vec<u8>> {
      let file = zip.by_name(name).ok()?;
      read_limited(file, 0).ok()
    };
    let mcmeta = entry("pack.mcmeta");
    let version_json = entry("version.json");
    let (pack_format, version) = parse_meta(mcmeta.as_deref(), version_json.as_deref());
    let info = SourceInfo { path: path.to_string_lossy().into_owned(), kind: "jar".into(), namespaces, pack_format, version };
    Ok(Source { backing: Backing::Jar(zip), info })
  }

  pub fn info(&self) -> SourceInfo {
    self.info.clone()
  }

  /// The bytes of `rel`, or `None` when it does not exist.
  pub fn read(&mut self, rel: &str) -> Result<Option<Vec<u8>>, String> {
    validate(rel)?;
    match &mut self.backing {
      Backing::Folder(root) => {
        let Ok(canonical) = root.join(rel).canonicalize() else { return Ok(None) };
        let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
        if !canonical.starts_with(&canonical_root) {
          return Err(format!("path \"{rel}\" leaves the source"));
        }
        if !canonical.is_file() {
          return Ok(None);
        }
        let file = File::open(&canonical).map_err(|e| e.to_string())?;
        let size = file.metadata().map(|m| m.len()).unwrap_or(0);
        read_limited(file, size).map(Some)
      }
      Backing::Jar(zip) => match zip.by_name(rel) {
        Ok(entry) if entry.is_file() => {
          let size = entry.size();
          read_limited(entry, size).map(Some)
        }
        Ok(_) | Err(zip::result::ZipError::FileNotFound) => Ok(None),
        Err(e) => Err(e.to_string()),
      },
    }
  }

  /// Sorted file paths under `prefix` (which must be inside `assets/`).
  pub fn list(&mut self, prefix: &str) -> Result<Vec<String>, String> {
    let trimmed = prefix.trim_end_matches('/');
    if trimmed != "assets" && !trimmed.starts_with("assets/") {
      return Err(format!("prefix \"{prefix}\" is outside assets/"));
    }
    check_components(trimmed)?;
    let dir_prefix = format!("{trimmed}/");
    let mut out: Vec<String> = Vec::new();
    match &mut self.backing {
      Backing::Folder(root) => {
        let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
        let mut stack = vec![(root.join(trimmed), trimmed.to_string())];
        'walk: while let Some((dir, rel)) = stack.pop() {
          let Ok(entries) = fs::read_dir(&dir) else { continue };
          for entry in entries.flatten() {
            let Ok(name) = entry.file_name().into_string() else { continue };
            let child = format!("{rel}/{name}");
            let path = entry.path();
            let Ok(canonical) = path.canonicalize() else { continue };
            if !canonical.starts_with(&canonical_root) {
              continue;
            }
            if canonical.is_dir() {
              stack.push((path, child));
            } else {
              out.push(child);
              if out.len() > MAX_LISTED {
                break 'walk;
              }
            }
          }
        }
      }
      Backing::Jar(zip) => {
        out = zip.file_names().filter(|n| n.starts_with(&dir_prefix) && !n.ends_with('/')).map(String::from).collect();
      }
    }
    out.sort();
    out.truncate(MAX_LISTED);
    Ok(out)
  }
}

/// Finds `versions/<v>/<v>.jar` files inside a launcher folder, newest first.
pub fn detect_in(minecraft_dir: &Path) -> Vec<Install> {
  let Ok(entries) = fs::read_dir(minecraft_dir.join("versions")) else { return Vec::new() };
  let mut installs: Vec<Install> = entries
    .flatten()
    .filter_map(|entry| {
      let version = entry.file_name().into_string().ok()?;
      let jar = entry.path().join(format!("{version}.jar"));
      let modified = fs::metadata(&jar).ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
      Some(Install { version, path: jar.to_string_lossy().into_owned(), modified })
    })
    .collect();
  installs.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| b.version.cmp(&a.version)));
  installs
}

fn minecraft_dir() -> Option<PathBuf> {
  let var = |name: &str| std::env::var_os(name).map(PathBuf::from);
  if cfg!(windows) {
    var("APPDATA").map(|p| p.join(".minecraft"))
  } else if cfg!(target_os = "macos") {
    var("HOME").map(|p| p.join("Library/Application Support/minecraft"))
  } else {
    var("HOME").map(|p| p.join(".minecraft"))
  }
}

pub fn detect_installs() -> Vec<Install> {
  minecraft_dir().map(|dir| detect_in(&dir)).unwrap_or_default()
}

/// The one source the frontend may read from.
#[derive(Default)]
pub struct McAssetsState(pub Mutex<Option<Source>>);

fn with_source<T>(state: &McAssetsState, f: impl FnOnce(&mut Source) -> Result<T, String>) -> Result<T, String> {
  let mut guard = state.0.lock().map_err(|_| "state poisoned".to_string())?;
  let source = guard.as_mut().ok_or_else(|| "no-source".to_string())?;
  f(source)
}

#[tauri::command]
pub fn mc_assets_detect() -> Vec<Install> {
  detect_installs()
}

#[tauri::command]
pub fn mc_assets_open(state: tauri::State<'_, McAssetsState>, path: String) -> Result<SourceInfo, String> {
  let source = Source::open(Path::new(&path))?;
  let info = source.info();
  *state.0.lock().map_err(|_| "state poisoned".to_string())? = Some(source);
  Ok(info)
}

#[tauri::command]
pub fn mc_assets_close(state: tauri::State<'_, McAssetsState>) {
  if let Ok(mut guard) = state.0.lock() {
    *guard = None;
  }
}

#[tauri::command]
pub fn mc_assets_info(state: tauri::State<'_, McAssetsState>) -> Option<SourceInfo> {
  state.0.lock().ok()?.as_ref().map(Source::info)
}

#[tauri::command]
pub fn mc_assets_read(state: tauri::State<'_, McAssetsState>, path: String) -> Result<tauri::ipc::Response, String> {
  let bytes = with_source(&state, |source| source.read(&path))?.ok_or_else(|| "not-found".to_string())?;
  Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn mc_assets_list(state: tauri::State<'_, McAssetsState>, prefix: String) -> Result<Vec<String>, String> {
  with_source(&state, |source| source.list(&prefix))
}

/// The largest skin image that will be read.
const MAX_SKIN_BYTES: u64 = 4 * 1024 * 1024;

/// Checks that `path` is a `.png` file of at most 4 MB, before anything is loaded.
fn check_skin(path: &Path) -> Result<(), String> {
  let is_png = path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("png"));
  if !is_png {
    return Err("a skin must be a .png file".into());
  }
  let meta = fs::metadata(path).map_err(|e| format!("Could not read \"{}\": {e}", path.display()))?;
  if !meta.is_file() {
    return Err(format!("\"{}\" is not a file", path.display()));
  }
  if meta.len() > MAX_SKIN_BYTES {
    return Err("skin is too large: the limit is 4 MB".into());
  }
  Ok(())
}

/// Reads a skin image the user picked, from anywhere on disk.
#[tauri::command]
pub fn mc_assets_read_skin(path: String) -> Result<tauri::ipc::Response, String> {
  let path = Path::new(&path);
  check_skin(path)?;
  fs::read(path).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

#[cfg(test)]
#[path = "mcassets_tests.rs"]
mod tests;
