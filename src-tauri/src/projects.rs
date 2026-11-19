//! Projects: folders (usually git repositories) that Tessel remembers, and file access scoped to them.
//!
//! The webview may read and write any file of the project kinds below inside a registered project
//! root, but nothing outside it: every relative path is checked lexically (no `..`, no drive letters,
//! no `.git`) and then against the real location on disk, so a symbolic link cannot lead out either.
//! Outside projects the extension allow-list of `files.rs` stays in force.

use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::files;

/// File kinds that belong in a project: Tessel documents, Minecraft models and resource-pack data
/// (`.json`, `.mcmeta`), images (textures), and the 3D formats Tessel imports and exports.
pub const PROJECT_EXTENSIONS: [&str; 14] =
  ["tessel", "json", "mcmeta", "png", "jpg", "jpeg", "webp", "glb", "gltf", "obj", "mtl", "stl", "ply", "fbx"];
/// Largest file read as text or bytes through the project commands.
pub const MAX_PROJECT_FILE_BYTES: u64 = files::MAX_IMPORT_BYTES;
/// Upper bound for a recursive listing, so a huge folder cannot stall the editor.
pub const MAX_LISTED_ENTRIES: usize = 5000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
  /// Stable id (hex), independent of name and folder.
  pub id: String,
  pub name: String,
  /// Absolute path of the project folder.
  pub path: String,
  /// URL of the `origin` remote, if the folder is a git repository with one.
  #[serde(default)]
  pub remote: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct StoredProjects {
  #[serde(default)]
  version: u32,
  #[serde(default)]
  projects: Vec<Project>,
}

/// The remembered projects, persisted as JSON (`projects.json` in the app config folder).
pub struct Registry {
  file: PathBuf,
  projects: Mutex<Vec<Project>>,
}

impl Registry {
  /// Loads the list; a missing or broken file is an empty list (a broken file is kept until the next save).
  pub fn load(file: PathBuf) -> Self {
    let projects = std::fs::read(&file)
      .ok()
      .and_then(|bytes| serde_json::from_slice::<StoredProjects>(&bytes).ok())
      .map(|stored| stored.projects)
      .unwrap_or_default();
    Self { file, projects: Mutex::new(projects) }
  }

  pub fn list(&self) -> Vec<Project> {
    self.projects.lock().unwrap().clone()
  }

  fn save(&self, projects: &[Project]) -> Result<(), String> {
    let stored = StoredProjects { version: 1, projects: projects.to_vec() };
    let json = serde_json::to_vec_pretty(&stored).map_err(|e| e.to_string())?;
    if let Some(parent) = self.file.parent() {
      std::fs::create_dir_all(parent).map_err(|e| format!("Could not save the project list: {e}"))?;
    }
    std::fs::write(&self.file, json).map_err(|e| format!("Could not save the project list: {e}"))
  }

  /// Registers an existing folder. A folder that is already registered is returned as it is
  /// (with its remote refreshed). `name` defaults to the folder name.
  pub fn add(&self, path: &str, name: Option<&str>, remote: Option<String>) -> Result<Project, String> {
    let folder = Path::new(path.trim());
    if !folder.is_absolute() {
      return Err(format!("\"{}\" is not an absolute path", folder.display()));
    }
    if !folder.is_dir() {
      return Err(format!("\"{}\" is not a folder", folder.display()));
    }
    let canonical = std::fs::canonicalize(folder).map_err(|e| format!("Could not open \"{}\": {e}", folder.display()))?;
    let mut projects = self.projects.lock().unwrap();
    if let Some(existing) = projects.iter_mut().find(|p| same_folder(&p.path, &canonical)) {
      if remote.is_some() {
        existing.remote = remote;
      }
      let project = existing.clone();
      self.save(&projects)?;
      return Ok(project);
    }
    let name = name
      .map(str::trim)
      .filter(|n| !n.is_empty())
      .map(str::to_string)
      .unwrap_or_else(|| folder.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Project".into()));
    let project = Project { id: new_id()?, name, path: clean_path(folder), remote };
    projects.push(project.clone());
    self.save(&projects)?;
    Ok(project)
  }

  /// Forgets a project; its folder stays on disk.
  pub fn remove(&self, id: &str) -> Result<(), String> {
    let mut projects = self.projects.lock().unwrap();
    let before = projects.len();
    projects.retain(|p| p.id != id);
    if projects.len() == before {
      return Err(format!("There is no project with the id \"{id}\""));
    }
    self.save(&projects)
  }

  pub fn rename(&self, id: &str, name: &str) -> Result<Project, String> {
    let name = name.trim();
    if name.is_empty() {
      return Err("The project name must not be empty".into());
    }
    let mut projects = self.projects.lock().unwrap();
    let project = projects
      .iter_mut()
      .find(|p| p.id == id)
      .ok_or_else(|| format!("There is no project with the id \"{id}\""))?;
    project.name = name.to_string();
    let project = project.clone();
    self.save(&projects)?;
    Ok(project)
  }

  /// Updates the stored remote URL (after a clone or when git reports a different one).
  pub fn set_remote(&self, id: &str, remote: Option<String>) -> Result<(), String> {
    let mut projects = self.projects.lock().unwrap();
    if let Some(project) = projects.iter_mut().find(|p| p.id == id)
      && project.remote != remote
    {
      project.remote = remote;
      self.save(&projects)?;
    }
    Ok(())
  }

  /// A project by id, by name (case-insensitive) or by its folder.
  pub fn find(&self, key: &str) -> Result<Project, String> {
    let key = key.trim();
    let projects = self.projects.lock().unwrap();
    let found = projects
      .iter()
      .find(|p| p.id == key)
      .or_else(|| projects.iter().find(|p| p.name.eq_ignore_ascii_case(key)))
      .or_else(|| {
        let canonical = std::fs::canonicalize(key).ok()?;
        projects.iter().find(|p| same_folder(&p.path, &canonical))
      });
    match found {
      Some(project) => Ok(project.clone()),
      None if projects.is_empty() => Err(format!("There is no project \"{key}\". No projects are registered yet.")),
      None => Err(format!(
        "There is no project \"{key}\". Projects: {}.",
        projects.iter().map(|p| format!("{} ({})", p.name, p.id)).collect::<Vec<_>>().join(", ")
      )),
    }
  }
}

fn same_folder(stored: &str, canonical: &Path) -> bool {
  std::fs::canonicalize(stored).is_ok_and(|p| p == canonical)
}

/// An absolute path without `.` components and without a trailing separator.
fn clean_path(path: &Path) -> String {
  let cleaned: PathBuf = path.components().filter(|c| !matches!(c, Component::CurDir)).collect();
  cleaned.to_string_lossy().into_owned()
}

fn new_id() -> Result<String, String> {
  let mut bytes = [0u8; 8];
  getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
  Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

// ---- path scoping ------------------------------------------------------------------------------

/// Whether `name` can be a file or folder name on every platform Tessel runs on.
pub fn valid_name(name: &str) -> bool {
  const FORBIDDEN: &str = "<>:\"/\\|?*";
  if name.is_empty() || name == "." || name == ".." || name.ends_with(['.', ' ']) || name.starts_with(' ') {
    return false;
  }
  if name.chars().any(|c| c.is_control() || FORBIDDEN.contains(c)) {
    return false;
  }
  let stem = name.split('.').next().unwrap_or_default().to_ascii_lowercase();
  let reserved = matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
    || (stem.len() == 4 && (stem.starts_with("com") || stem.starts_with("lpt")) && stem.ends_with(|c: char| c.is_ascii_digit()));
  !reserved
}

/// The components of a project-relative path (`/` or `\` separated). Rejects anything that could
/// leave the project or touch git's own data: absolute paths, drive letters, `..`, `.git`.
pub fn relative_components(relative: &str) -> Result<Vec<String>, String> {
  let trimmed = relative.trim();
  if trimmed.starts_with(['/', '\\']) || Path::new(trimmed).is_absolute() || trimmed.contains(':') {
    return Err(format!("\"{}\" must be a path inside the project, relative to its folder", short(trimmed)));
  }
  let mut parts = Vec::new();
  for part in trimmed.split(['/', '\\']) {
    match part {
      "" | "." => {}
      ".." => return Err(format!("\"{}\" leads out of the project", short(trimmed))),
      _ if part.eq_ignore_ascii_case(".git") => return Err("The .git folder of a project cannot be accessed".into()),
      _ if !valid_name(part) => return Err(format!("\"{}\" is not a valid file or folder name", short(part))),
      _ => parts.push(part.to_string()),
    }
  }
  Ok(parts)
}

/// `relative` as an absolute path inside `root`. The deepest part of it that exists on disk must
/// really be inside the root (symbolic links and junctions are resolved).
pub fn resolve(root: &Path, relative: &str) -> Result<PathBuf, String> {
  let parts = relative_components(relative)?;
  let canonical_root = std::fs::canonicalize(root).map_err(|e| format!("The project folder \"{}\" is not available: {e}", root.display()))?;
  let mut path = root.to_path_buf();
  for part in &parts {
    path.push(part);
  }
  let mut existing = path.as_path();
  while !existing.exists() {
    existing = match existing.parent() {
      Some(parent) => parent,
      None => break,
    };
  }
  let canonical = std::fs::canonicalize(existing).map_err(|e| format!("Could not open \"{}\": {e}", existing.display()))?;
  if !canonical.starts_with(&canonical_root) {
    return Err(format!("\"{}\" leads out of the project", short(relative)));
  }
  Ok(path)
}

/// A path the caller gave either relative to the project or as an absolute path inside it → relative, `/`-separated.
pub fn to_relative(root: &Path, path: &str) -> Result<String, String> {
  let candidate = Path::new(path.trim());
  if !candidate.is_absolute() {
    return Ok(relative_components(path)?.join("/"));
  }
  let canonical_root = std::fs::canonicalize(root).map_err(|e| format!("The project folder is not available: {e}"))?;
  // The file may not exist yet: resolve its folder.
  let (folder, file) = match (candidate.parent(), candidate.file_name()) {
    (Some(folder), Some(file)) => (folder, Some(file)),
    _ => (candidate, None),
  };
  let canonical_folder = std::fs::canonicalize(folder).map_err(|_| format!("\"{}\" is not inside the project folder {}", short(path), root.display()))?;
  let inside = canonical_folder
    .strip_prefix(&canonical_root)
    .map_err(|_| format!("\"{}\" is not inside the project folder {}", short(path), root.display()))?;
  let mut parts: Vec<String> = inside.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
  if let Some(file) = file {
    parts.push(file.to_string_lossy().into_owned());
  }
  Ok(relative_components(&parts.join("/"))?.join("/"))
}

fn require_project_extension(relative: &str) -> Result<(), String> {
  let extension = files::extension(relative);
  if PROJECT_EXTENSIONS.contains(&extension.as_str()) {
    Ok(())
  } else {
    Err(format!("\"{}\" must end in .{}", short(relative), PROJECT_EXTENSIONS.join(", .")))
  }
}

fn short(text: &str) -> String {
  crate::tools::short(text)
}

// ---- listing and file operations ---------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
  pub name: String,
  /// Relative to the project root, `/`-separated.
  pub path: String,
  /// `dir` or `file`.
  pub kind: &'static str,
  pub size: u64,
  /// Last change, milliseconds since 1970.
  pub modified: u64,
  /// Git status of the file (or, for a folder, whether something inside changed): `modified`,
  /// `new`, `deleted`, `renamed`, `conflicted`; absent when unchanged or not in a repository.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub git: Option<String>,
}

/// The folders and project files directly inside `relative` (hidden entries such as `.git` are left
/// out), folders first, then by name.
pub fn list_dir(root: &Path, relative: &str) -> Result<Vec<Entry>, String> {
  let folder = resolve(root, relative)?;
  let prefix = relative_components(relative)?.join("/");
  let read = std::fs::read_dir(&folder).map_err(|e| format!("Could not list \"{}\": {e}", folder.display()))?;
  let mut entries = Vec::new();
  for item in read.flatten() {
    let name = item.file_name().to_string_lossy().into_owned();
    if name.starts_with('.') {
      continue;
    }
    let Ok(meta) = item.metadata() else { continue };
    let is_dir = meta.is_dir();
    if !is_dir && !PROJECT_EXTENSIONS.contains(&files::extension(&name).as_str()) {
      continue;
    }
    let modified = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
    entries.push(Entry {
      path: if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") },
      name,
      kind: if is_dir { "dir" } else { "file" },
      size: if is_dir { 0 } else { meta.len() },
      modified,
      git: None,
    });
  }
  entries.sort_by(|a, b| (a.kind != "dir").cmp(&(b.kind != "dir")).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
  Ok(entries)
}

/// Every project file below `relative` (folders are walked, not listed), up to `MAX_LISTED_ENTRIES`.
/// The second value is true if the listing was cut off.
pub fn list_files(root: &Path, relative: &str) -> Result<(Vec<Entry>, bool), String> {
  let mut files = Vec::new();
  let mut pending = vec![relative_components(relative)?.join("/")];
  while let Some(folder) = pending.pop() {
    for entry in list_dir(root, &folder)? {
      if entry.kind == "dir" {
        pending.push(entry.path);
      } else {
        if files.len() >= MAX_LISTED_ENTRIES {
          return Ok((files, true));
        }
        files.push(entry);
      }
    }
  }
  files.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
  Ok((files, false))
}

fn path_text(path: &Path) -> String {
  path.to_string_lossy().into_owned()
}

pub async fn read_bytes(root: &Path, relative: &str) -> Result<Vec<u8>, String> {
  require_project_extension(relative)?;
  let path = resolve(root, relative)?;
  files::read_bytes_capped(&path_text(&path), MAX_PROJECT_FILE_BYTES, "open").await
}

pub async fn read_text(root: &Path, relative: &str) -> Result<String, String> {
  files::decode_text(&read_bytes(root, relative).await?).map_err(|e| format!("\"{}\" cannot be read: {e}", short(relative)))
}

/// Writes a project file, creating missing folders.
pub async fn write_bytes(root: &Path, relative: &str, bytes: &[u8]) -> Result<PathBuf, String> {
  require_project_extension(relative)?;
  let path = resolve(root, relative)?;
  if relative_components(relative)?.is_empty() || path.is_dir() {
    return Err(format!("\"{}\" is a folder", short(relative)));
  }
  files::write_bytes(&path_text(&path), bytes).await?;
  Ok(path)
}

pub fn create_dir(root: &Path, relative: &str) -> Result<PathBuf, String> {
  let path = resolve(root, relative)?;
  if path.exists() {
    return Err(format!("\"{}\" already exists", short(relative)));
  }
  std::fs::create_dir_all(&path).map_err(|e| format!("Could not create \"{}\": {e}", short(relative)))?;
  Ok(path)
}

/// Renames or moves a file or folder inside the project. The target must not exist; a file keeps
/// to the project kinds.
pub fn rename(root: &Path, from: &str, to: &str) -> Result<PathBuf, String> {
  if relative_components(from)?.is_empty() || relative_components(to)?.is_empty() {
    return Err("The project folder itself cannot be renamed here".into());
  }
  let source = resolve(root, from)?;
  let target = resolve(root, to)?;
  if !source.exists() {
    return Err(format!("\"{}\" does not exist", short(from)));
  }
  if source.is_file() {
    require_project_extension(to)?;
  }
  // Only a change of letter case may point at the same entry (case-insensitive file systems).
  if target.exists() && !from.eq_ignore_ascii_case(to) {
    return Err(format!("\"{}\" already exists", short(to)));
  }
  if let Some(parent) = target.parent() {
    std::fs::create_dir_all(parent).map_err(|e| format!("Could not create \"{}\": {e}", parent.display()))?;
  }
  std::fs::rename(&source, &target).map_err(|e| format!("Could not rename \"{}\": {e}", short(from)))?;
  Ok(target)
}

/// Moves a file or folder of the project to the trash (the recycle bin on Windows).
pub fn delete(root: &Path, relative: &str) -> Result<(), String> {
  if relative_components(relative)?.is_empty() {
    return Err("The project folder itself cannot be deleted here".into());
  }
  let path = resolve(root, relative)?;
  if !path.exists() {
    return Err(format!("\"{}\" does not exist", short(relative)));
  }
  if path.is_file() {
    require_project_extension(relative)?;
  }
  trash::delete(&path).map_err(|e| format!("Could not move \"{}\" to the trash: {e}", short(relative)))
}

#[cfg(test)]
#[path = "projects_tests.rs"]
mod tests;
