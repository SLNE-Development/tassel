//! The projects and the GitHub account together, shared by the webview commands below and by the
//! native MCP tools (`workspace_tools.rs`).

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::files;
use crate::git::{self, Branches, CommitResult, PullResult, RepoStatus};
use crate::github::{Account, DeviceCode, GitHub, KeyringStore, Repo, TokenStore, User};
use crate::projects::{self, Entry, Project, Registry};

pub struct Workspace {
  pub projects: Registry,
  pub github: GitHub,
}

static GLOBAL: OnceLock<Arc<Workspace>> = OnceLock::new();

/// The workspace of the running app, for the MCP tools; None before setup (and in tests).
pub fn global() -> Option<Arc<Workspace>> {
  GLOBAL.get().cloned()
}

/// Loads the project list and GitHub settings from the app config folder.
pub fn init(config_dir: &Path) -> Arc<Workspace> {
  let workspace = Arc::new(Workspace::new(config_dir, Box::new(KeyringStore)));
  let _ = GLOBAL.set(workspace.clone());
  workspace
}

/// A project as the UI shows it: the stored fields plus what git says right now.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
  #[serde(flatten)]
  pub project: Project,
  pub exists: bool,
  pub is_repo: bool,
  pub branch: Option<String>,
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tokio::task::spawn_blocking(work).await.map_err(|e| format!("The operation was interrupted: {e}"))?
}

impl Workspace {
  pub fn new(config_dir: &Path, tokens: Box<dyn TokenStore>) -> Self {
    Self {
      projects: Registry::load(config_dir.join("projects.json")),
      github: GitHub::new(config_dir.join("github.json"), tokens),
    }
  }

  pub fn project(&self, key: &str) -> Result<Project, String> {
    self.projects.find(key)
  }

  fn root(&self, key: &str) -> Result<(Project, PathBuf), String> {
    let project = self.project(key)?;
    let root = PathBuf::from(&project.path);
    if !root.is_dir() {
      return Err(format!("The folder of the project \"{}\" is missing: {}", project.name, project.path));
    }
    Ok((project, root))
  }

  pub fn info(&self, project: Project) -> ProjectInfo {
    let root = Path::new(&project.path);
    let exists = root.is_dir();
    let status = if exists { git::status(root).ok() } else { None };
    ProjectInfo {
      exists,
      is_repo: status.as_ref().is_some_and(|s| s.is_repo),
      branch: status.and_then(|s| s.branch),
      project,
    }
  }

  pub fn list(&self) -> Vec<ProjectInfo> {
    self.projects.list().into_iter().map(|p| self.info(p)).collect()
  }

  pub fn add(&self, path: &str, name: Option<&str>) -> Result<ProjectInfo, String> {
    let remote = git::origin_url(Path::new(path.trim()));
    let project = self.projects.add(path, name, remote)?;
    Ok(self.info(project))
  }

  /// Entries of one folder of a project, with their git status.
  pub fn list_dir(&self, key: &str, dir: &str) -> Result<Vec<Entry>, String> {
    let (_, root) = self.root(key)?;
    let mut entries = projects::list_dir(&root, dir)?;
    let status = git::status_map(&root);
    for entry in &mut entries {
      entry.git = status.get(&entry.path).cloned();
    }
    Ok(entries)
  }

  /// Every project file (recursively) with its git status; true if cut off.
  pub fn list_files(&self, key: &str, dir: &str) -> Result<(Vec<Entry>, bool), String> {
    let (_, root) = self.root(key)?;
    let (mut entries, truncated) = projects::list_files(&root, dir)?;
    let status = git::status_map(&root);
    for entry in &mut entries {
      entry.git = status.get(&entry.path).cloned();
    }
    Ok((entries, truncated))
  }

  /// A path given relative to the project or absolute inside it → relative.
  pub fn relative(&self, key: &str, path: &str) -> Result<(Project, PathBuf, String), String> {
    let (project, root) = self.root(key)?;
    let relative = projects::to_relative(&root, path)?;
    Ok((project, root, relative))
  }

  pub async fn git_status(&self, key: &str) -> Result<RepoStatus, String> {
    let (_, root) = self.root(key)?;
    blocking(move || git::status(&root)).await
  }

  pub async fn git_branches(&self, key: &str, fetch: bool) -> Result<Branches, String> {
    let (_, root) = self.root(key)?;
    let token = self.github.token();
    blocking(move || {
      if fetch {
        git::fetch_all(&root, token.as_deref())?;
      }
      git::branches(&root)
    })
    .await
  }

  pub async fn git_switch_branch(&self, key: &str, branch: &str) -> Result<String, String> {
    let (_, root) = self.root(key)?;
    let branch = branch.to_string();
    blocking(move || git::switch_branch(&root, &branch)).await
  }

  pub async fn git_commit(&self, key: &str, message: &str, files: Option<Vec<String>>) -> Result<CommitResult, String> {
    let (_, root) = self.root(key)?;
    let message = message.to_string();
    let identity = self.github.identity();
    blocking(move || git::commit(&root, &message, files.as_deref(), identity.as_ref())).await
  }

  pub async fn git_pull(&self, key: &str) -> Result<PullResult, String> {
    let (_, root) = self.root(key)?;
    let token = self.github.token();
    let identity = self.github.identity();
    blocking(move || git::pull(&root, token.as_deref(), identity.as_ref())).await
  }

  pub async fn git_push(&self, key: &str) -> Result<String, String> {
    let (_, root) = self.root(key)?;
    let token = self.github.token();
    blocking(move || git::push(&root, token.as_deref())).await
  }

  /// Clones a repository into `parent/name` and registers it as a project.
  pub async fn clone_repo(&self, url: &str, parent: &str, name: &str) -> Result<ProjectInfo, String> {
    if !url.starts_with("https://") {
      return Err("Only https:// repository URLs can be cloned".into());
    }
    let parent = Path::new(parent.trim());
    if !parent.is_absolute() || !parent.is_dir() {
      return Err(format!("\"{}\" is not a folder", parent.display()));
    }
    let name = name.trim();
    if !projects::valid_name(name) {
      return Err(format!("\"{name}\" is not a valid folder name"));
    }
    let destination = parent.join(name);
    let token = self.github.token();
    let (source, target) = (url.to_string(), destination.clone());
    blocking(move || git::clone(&source, &target, token.as_deref())).await?;
    let project = self.projects.add(&destination.to_string_lossy(), Some(name), Some(url.to_string()))?;
    Ok(self.info(project))
  }
}

// ---- webview commands ------------------------------------------------------------------------------

type Ws<'a> = State<'a, Arc<Workspace>>;

#[tauri::command]
pub fn project_list(ws: Ws<'_>) -> Vec<ProjectInfo> {
  ws.list()
}

#[tauri::command]
pub fn project_add(ws: Ws<'_>, path: String, name: Option<String>) -> Result<ProjectInfo, String> {
  ws.add(&path, name.as_deref())
}

#[tauri::command]
pub fn project_remove(ws: Ws<'_>, id: String) -> Result<(), String> {
  ws.projects.remove(&id)
}

#[tauri::command]
pub fn project_rename(ws: Ws<'_>, id: String, name: String) -> Result<ProjectInfo, String> {
  let project = ws.projects.rename(&id, &name)?;
  Ok(ws.info(project))
}

#[tauri::command]
pub async fn project_list_dir(ws: Ws<'_>, project_id: String, dir: String) -> Result<Vec<Entry>, String> {
  let ws = ws.inner().clone();
  blocking(move || ws.list_dir(&project_id, &dir)).await
}

#[tauri::command]
pub async fn project_read_text(ws: Ws<'_>, project_id: String, path: String) -> Result<String, String> {
  let (_, root, relative) = ws.relative(&project_id, &path)?;
  projects::read_text(&root, &relative).await
}

#[tauri::command]
pub async fn project_read_binary(ws: Ws<'_>, project_id: String, path: String) -> Result<String, String> {
  let (_, root, relative) = ws.relative(&project_id, &path)?;
  Ok(files::encode_base64(&projects::read_bytes(&root, &relative).await?))
}

/// Writes a text file into a project; returns its absolute path.
#[tauri::command]
pub async fn project_write_text(ws: Ws<'_>, project_id: String, path: String, contents: String) -> Result<String, String> {
  let (_, root, relative) = ws.relative(&project_id, &path)?;
  Ok(projects::write_bytes(&root, &relative, contents.as_bytes()).await?.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn project_write_binary(ws: Ws<'_>, project_id: String, path: String, base64: String) -> Result<String, String> {
  let (_, root, relative) = ws.relative(&project_id, &path)?;
  let bytes = files::decode_base64(&base64)?;
  Ok(projects::write_bytes(&root, &relative, &bytes).await?.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn project_create_dir(ws: Ws<'_>, project_id: String, path: String) -> Result<(), String> {
  let (_, root, relative) = ws.relative(&project_id, &path)?;
  projects::create_dir(&root, &relative).map(drop)
}

#[tauri::command]
pub fn project_move(ws: Ws<'_>, project_id: String, from: String, to: String) -> Result<String, String> {
  let (_, root, from) = ws.relative(&project_id, &from)?;
  let to = projects::to_relative(&root, &to)?;
  projects::rename(&root, &from, &to)?;
  Ok(to)
}

#[tauri::command]
pub fn project_trash(ws: Ws<'_>, project_id: String, path: String) -> Result<(), String> {
  let (_, root, relative) = ws.relative(&project_id, &path)?;
  projects::delete(&root, &relative)
}

#[tauri::command]
pub async fn git_status(ws: Ws<'_>, project_id: String) -> Result<RepoStatus, String> {
  ws.git_status(&project_id).await
}

#[tauri::command]
pub async fn git_branches(ws: Ws<'_>, project_id: String, fetch: Option<bool>) -> Result<Branches, String> {
  ws.git_branches(&project_id, fetch.unwrap_or(false)).await
}

#[tauri::command]
pub async fn git_switch_branch(ws: Ws<'_>, project_id: String, branch: String) -> Result<String, String> {
  ws.git_switch_branch(&project_id, &branch).await
}

#[tauri::command]
pub async fn git_commit(ws: Ws<'_>, project_id: String, message: String, files: Option<Vec<String>>) -> Result<CommitResult, String> {
  ws.git_commit(&project_id, &message, files).await
}

#[tauri::command]
pub async fn git_pull(ws: Ws<'_>, project_id: String) -> Result<PullResult, String> {
  ws.git_pull(&project_id).await
}

#[tauri::command]
pub async fn git_push(ws: Ws<'_>, project_id: String) -> Result<String, String> {
  ws.git_push(&project_id).await
}

#[tauri::command]
pub async fn github_account(ws: Ws<'_>) -> Result<Account, String> {
  ws.github.account().await
}

#[tauri::command]
pub fn github_set_client_id(ws: Ws<'_>, client_id: Option<String>) -> Result<(), String> {
  ws.github.set_client_id(client_id.as_deref())
}

/// Starts the device flow and opens the verification page in the system browser.
#[tauri::command]
pub async fn github_login_start(app: AppHandle, ws: Ws<'_>) -> Result<DeviceCode, String> {
  let code = ws.github.start_login().await?;
  if code.verification_uri.starts_with("https://github.com/")
    && let Err(e) = app.opener().open_url(&code.verification_uri, None::<&str>)
  {
    log::warn!("Could not open the browser: {e}");
  }
  Ok(code)
}

#[tauri::command]
pub async fn github_login_wait(ws: Ws<'_>) -> Result<User, String> {
  ws.github.wait_login().await
}

/// Signs in with a personal access token typed by the user; it goes straight to the credential store.
#[tauri::command]
pub async fn github_login_token(ws: Ws<'_>, token: String) -> Result<User, String> {
  ws.github.login_with_token(&token).await
}

#[tauri::command]
pub fn github_login_cancel(ws: Ws<'_>) {
  ws.github.cancel_login();
}

#[tauri::command]
pub fn github_logout(ws: Ws<'_>) -> Result<(), String> {
  ws.github.logout()
}

#[tauri::command]
pub async fn github_repos(ws: Ws<'_>, query: Option<String>) -> Result<Vec<Repo>, String> {
  ws.github.repos(query.as_deref()).await
}

#[tauri::command]
pub async fn github_owners(ws: Ws<'_>) -> Result<Vec<String>, String> {
  ws.github.owners().await
}

#[tauri::command]
pub async fn github_create_repo(
  ws: Ws<'_>,
  owner: String,
  name: String,
  private: bool,
  description: Option<String>,
) -> Result<Repo, String> {
  ws.github.create_repo(&owner, &name, private, description.as_deref()).await
}

#[tauri::command]
pub async fn github_clone(ws: Ws<'_>, clone_url: String, parent: String, name: String) -> Result<ProjectInfo, String> {
  ws.clone_repo(&clone_url, &parent, &name).await
}

/// Opens a project folder in the system file manager.
#[tauri::command]
pub fn project_reveal(app: AppHandle, ws: Ws<'_>, project_id: String, path: Option<String>) -> Result<(), String> {
  let (_, root, relative) = ws.relative(&project_id, path.as_deref().unwrap_or(""))?;
  let target = projects::resolve(&root, &relative)?;
  app.opener().reveal_item_in_dir(&target).map_err(|e| format!("Could not show the folder: {e}"))
}

/// A result as JSON for an MCP tool.
pub fn to_json<T: Serialize>(value: &T) -> Value {
  serde_json::to_value(value).unwrap_or(Value::Null)
}
