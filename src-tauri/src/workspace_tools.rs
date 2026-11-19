//! Native MCP tools for projects and git. They run in Rust like the file tools; the GitHub token is
//! used for pull and push but never appears in arguments or results.

use std::path::Path;

use serde_json::{Map, Value, json};

use crate::bridge::Frontend;
use crate::tools::{self, NativeTool, short};
use crate::workspace::{self, Workspace, to_json};

pub const NAMES: [&str; 10] = [
  "project_list",
  "project_files",
  "project_open",
  "project_save",
  "git_status",
  "git_branches",
  "git_switch_branch",
  "git_commit",
  "git_pull",
  "git_push",
];

pub fn is_workspace_tool(tool: &str) -> bool {
  NAMES.contains(&tool)
}

fn project_schema() -> Value {
  json!({ "type": "string", "description": "The project: its id or its name (see project_list)." })
}

pub fn tools() -> Vec<NativeTool> {
  let only_project = |extra: Value| {
    let mut properties = Map::new();
    properties.insert("project".into(), project_schema());
    if let Value::Object(extra) = extra {
      properties.extend(extra);
    }
    json!({ "type": "object", "properties": properties, "required": ["project"], "additionalProperties": false })
  };
  vec![
    NativeTool {
      name: "project_list",
      description: "List the projects Tessel knows: folders (usually git repositories, e.g. one per Minecraft server) \
        that the team keeps models in. The user adds projects and clones GitHub repositories in the Projects panel. \
        Returns { projects: [{ id, name, path (absolute folder), remote (origin URL), exists, isRepo, branch }] }. \
        Use the id or name as \"project\" in the other project_* and git_* tools.",
      input_schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
    },
    NativeTool {
      name: "project_files",
      description: "List the model files of a project: .tessel documents, Minecraft model and resource-pack data \
        (.json, .mcmeta), images (.png, .jpg, .webp) and 3D files. Paths are relative to the project folder with / \
        as separator (resource packs keep textures as assets/<namespace>/textures/...). Hidden folders such as .git \
        are left out. recursive (default true) lists every file below dir; false lists dir's direct folders and \
        files. Each entry: { name, path, kind (file | dir), size, modified (ms since 1970), git? (new | modified | \
        deleted | renamed | conflicted; absent if unchanged) }. Returns { project, dir, entries, truncated }.",
      input_schema: only_project(json!({
        "dir": { "type": "string", "description": "Folder inside the project, relative. Default: the project folder." },
        "recursive": { "type": "boolean", "default": true }
      })),
    },
    NativeTool {
      name: "project_open",
      description: "Open a .tessel document of a project in a new editor tab (like file_open, but the path is relative \
        to the project and cannot leave it). Saving it later with file_save writes it back to the same place. \
        Returns what file_open returns, plus project.",
      input_schema: only_project(json!({
        "path": { "type": "string", "description": "Path of the .tessel file, relative to the project (or absolute inside it)." },
        "activate": { "type": "boolean", "description": "Switch the visible tab to it. Default true." }
      })),
    },
    NativeTool {
      name: "project_save",
      description: "Save a document into a project as a .tessel file (missing folders are created, an existing file is \
        overwritten); the document then belongs to that file, so file_save without a path writes there again. The path \
        is relative to the project and cannot leave it. Commit and push it with git_commit and git_push. Returns what \
        file_save returns, plus project.",
      input_schema: only_project(json!({
        "path": { "type": "string", "description": "Path relative to the project, ending in .tessel, e.g. models/chair.tessel." },
        "documentId": { "type": "string", "description": "Id of an open document (see document_list) instead of the active one." }
      })),
    },
    NativeTool {
      name: "git_status",
      description: "Git status of a project: { isRepo, branch, detached, upstream, ahead (commits not pushed), behind \
        (commits on the remote not pulled, as of the last pull), remote, state (clean, merge, ...), files: [{ path, \
        status (new | modified | deleted | renamed | conflicted), staged }] }.",
      input_schema: only_project(json!({})),
    },
    NativeTool {
      name: "git_branches",
      description: "Branches of a project: { current, local, remote (branches on origin without a local branch) }. \
        fetch true first downloads the branch list from the remote (GitHub repositories use the account signed in \
        to Tessel).",
      input_schema: only_project(json!({ "fetch": { "type": "boolean", "default": false } })),
    },
    NativeTool {
      name: "git_switch_branch",
      description: "Check out another branch of a project (a remote branch gets a local branch that tracks it). Refused \
        when uncommitted changes would be overwritten. Open documents from the project are not reloaded. Returns \
        { branch }.",
      input_schema: only_project(json!({ "branch": { "type": "string" } })),
    },
    NativeTool {
      name: "git_commit",
      description: "Commit changes of a project: the listed files (relative paths; deleted files are committed as \
        deletions) or, without files, every change. Save open documents first (file_save / project_save). Returns \
        { commit (sha), branch, files (number of files in the commit) }.",
      input_schema: only_project(json!({
        "message": { "type": "string", "description": "Commit message." },
        "files": { "type": "array", "items": { "type": "string" }, "description": "Files to commit. Default: all changes." }
      })),
    },
    NativeTool {
      name: "git_pull",
      description: "Get the changes of the team: fetch the current branch from origin and fast-forward, or merge when \
        both sides have new commits. If both sides changed the same files, or uncommitted changes would be overwritten, \
        nothing changes and the error names the files. Returns { result (up-to-date | fast-forward | merged), branch, \
        commit }.",
      input_schema: only_project(json!({})),
    },
    NativeTool {
      name: "git_push",
      description: "Upload the commits of the current branch to origin. Fails with a hint to pull first when the remote \
        has newer commits, or to sign in when GitHub refuses access. Returns { pushed: true, branch }.",
      input_schema: only_project(json!({})),
    },
  ]
}

fn args_object<'a>(args: &'a Value, tool: &str, allowed: &[&str]) -> Result<&'a Map<String, Value>, String> {
  let map = args.as_object().ok_or_else(|| format!("The arguments of {tool} must be an object"))?;
  match map.keys().find(|key| !allowed.contains(&key.as_str())) {
    Some(key) => Err(format!("Unknown parameter \"{}\" for {tool}. Parameters: {}.", short(key), allowed.join(", "))),
    None => Ok(map),
  }
}

fn text<'a>(map: &'a Map<String, Value>, key: &str, required: bool) -> Result<Option<&'a str>, String> {
  match map.get(key) {
    None | Some(Value::Null) if required => Err(format!("\"{key}\" is required")),
    None | Some(Value::Null) => Ok(None),
    Some(Value::String(text)) if !text.trim().is_empty() => Ok(Some(text.trim())),
    Some(_) => Err(format!("\"{key}\" must be a non-empty string")),
  }
}

fn flag(map: &Map<String, Value>, key: &str) -> Result<Option<bool>, String> {
  match map.get(key) {
    None | Some(Value::Null) => Ok(None),
    Some(Value::Bool(flag)) => Ok(Some(*flag)),
    Some(_) => Err(format!("\"{key}\" must be true or false")),
  }
}

/// Checks the arguments without touching anything (for `batch { validateOnly }`).
pub fn check(tool: &str, args: &Value) -> Result<(), String> {
  let (allowed, required): (&[&str], &[&str]) = match tool {
    "project_list" => (&[], &[]),
    "project_files" => (&["project", "dir", "recursive"], &["project"]),
    "project_open" => (&["project", "path", "activate"], &["project", "path"]),
    "project_save" => (&["project", "path", "documentId"], &["project", "path"]),
    "git_branches" => (&["project", "fetch"], &["project"]),
    "git_switch_branch" => (&["project", "branch"], &["project", "branch"]),
    "git_commit" => (&["project", "message", "files"], &["project", "message"]),
    _ => (&["project"], &["project"]),
  };
  let map = args_object(args, tool, allowed)?;
  for key in required {
    text(map, key, true)?;
  }
  for key in ["dir", "documentId"] {
    if allowed.contains(&key) {
      text(map, key, false)?;
    }
  }
  for key in ["recursive", "activate", "fetch"] {
    if allowed.contains(&key) {
      flag(map, key)?;
    }
  }
  if let Some(files) = map.get("files")
    && !files.is_null()
    && !files.as_array().is_some_and(|items| items.iter().all(Value::is_string))
  {
    return Err("\"files\" must be an array of paths".into());
  }
  if matches!(tool, "project_open" | "project_save")
    && let Some(path) = text(map, "path", true)?
    && crate::files::extension(path) != "tessel"
  {
    return Err(format!("\"{}\" must end in .tessel", short(path)));
  }
  Ok(())
}

/// Runs a project or git tool against the running app's workspace.
pub async fn call<F: Frontend>(frontend: &F, tool: &str, args: Value) -> Result<Value, String> {
  let workspace = workspace::global().ok_or("Projects are not available (the app has not finished starting)")?;
  call_with(&workspace, frontend, tool, args).await
}

pub async fn call_with<F: Frontend>(ws: &Workspace, frontend: &F, tool: &str, args: Value) -> Result<Value, String> {
  check(tool, &args)?;
  let map = args.as_object().cloned().unwrap_or_default();
  if tool == "project_list" {
    return Ok(json!({ "projects": to_json(&ws.list()) }));
  }
  let key = text(&map, "project", true)?.unwrap_or_default();
  let project = ws.project(key)?;
  let named = json!({ "id": project.id, "name": project.name });
  let with_project = |value: Value| match value {
    Value::Object(mut object) => {
      object.insert("project".into(), named.clone());
      Value::Object(object)
    }
    other => json!({ "project": named.clone(), "result": other }),
  };
  match tool {
    "project_files" => {
      let dir = text(&map, "dir", false)?.unwrap_or("");
      let (_, _, dir) = ws.relative(&project.id, dir)?;
      let (entries, truncated) = if flag(&map, "recursive")?.unwrap_or(true) {
        ws.list_files(&project.id, &dir)?
      } else {
        (ws.list_dir(&project.id, &dir)?, false)
      };
      Ok(json!({ "project": named, "dir": dir, "entries": to_json(&entries), "truncated": truncated }))
    }
    "project_open" | "project_save" => {
      let path = text(&map, "path", true)?.unwrap_or_default();
      let (_, root, relative) = ws.relative(&project.id, path)?;
      let absolute = crate::projects::resolve(&root, &relative)?;
      let mut forwarded = map.clone();
      forwarded.remove("project");
      forwarded.insert("path".into(), json!(absolute.to_string_lossy()));
      let forwarded = Value::Object(forwarded);
      let mut result = if tool == "project_open" {
        tools::file_open(frontend, &forwarded).await?
      } else {
        tools::file_save(frontend, &forwarded).await?
      };
      if let Some(object) = result.as_object_mut() {
        object.insert("relativePath".into(), json!(relative));
      }
      Ok(with_project(result))
    }
    "git_status" => Ok(with_project(to_json(&ws.git_status(&project.id).await?))),
    "git_branches" => Ok(with_project(to_json(&ws.git_branches(&project.id, flag(&map, "fetch")?.unwrap_or(false)).await?))),
    "git_switch_branch" => {
      let branch = ws.git_switch_branch(&project.id, text(&map, "branch", true)?.unwrap_or_default()).await?;
      Ok(with_project(json!({ "branch": branch })))
    }
    "git_commit" => {
      let files = map.get("files").and_then(Value::as_array).map(|items| {
        items.iter().filter_map(Value::as_str).map(|path| {
          crate::projects::to_relative(Path::new(&project.path), path).unwrap_or_else(|_| path.to_string())
        }).collect::<Vec<_>>()
      });
      let message = text(&map, "message", true)?.unwrap_or_default();
      Ok(with_project(to_json(&ws.git_commit(&project.id, message, files).await?)))
    }
    "git_pull" => Ok(with_project(to_json(&ws.git_pull(&project.id).await?))),
    "git_push" => {
      let branch = ws.git_push(&project.id).await?;
      Ok(with_project(json!({ "pushed": true, "branch": branch })))
    }
    other => Err(format!("Unknown project tool \"{}\"", short(other))),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::github::MemoryStore;
  use crate::testing::{Mock, TempDir, block_on};

  fn setup(name: &str) -> (TempDir, TempDir, Workspace) {
    let config = TempDir::new(&format!("{name}-config"));
    let project = TempDir::new(&format!("{name}-project"));
    let ws = Workspace::new(&config.0, Box::new(MemoryStore::default()));
    ws.add(&project.0.to_string_lossy(), Some("Survival")).unwrap();
    (config, project, ws)
  }

  #[test]
  fn listed_tools_are_known_and_checked() {
    let listed: Vec<&str> = tools().iter().map(|t| t.name).collect();
    assert_eq!(listed, NAMES);
    assert!(check("project_open", &json!({ "project": "x", "path": "a.json" })).unwrap_err().contains(".tessel"));
    assert!(check("git_commit", &json!({ "project": "x" })).unwrap_err().contains("\"message\" is required"));
    assert!(check("git_commit", &json!({ "project": "x", "message": "m", "files": [1] })).is_err());
    assert!(check("git_push", &json!({ "project": "x", "token": "t" })).unwrap_err().contains("Unknown parameter"));
    assert!(check("project_list", &json!({})).is_ok());
  }

  #[test]
  fn project_tools_work_inside_the_project_only() {
    let (_config, project, ws) = setup("ws-tools");
    let mock = Mock::new();
    std::fs::create_dir_all(project.0.join("models")).unwrap();
    std::fs::write(project.0.join("models/chair.tessel"), "{}").unwrap();

    let list = block_on(call_with(&ws, &mock, "project_list", json!({}))).unwrap();
    assert_eq!(list["projects"][0]["name"], "Survival");
    assert_eq!(list["projects"][0]["isRepo"], false);

    let files = block_on(call_with(&ws, &mock, "project_files", json!({ "project": "survival" }))).unwrap();
    assert_eq!(files["entries"][0]["path"], "models/chair.tessel");

    let saved = block_on(call_with(&ws, &mock, "project_save", json!({ "project": "Survival", "path": "props/lamp.tessel" }))).unwrap();
    assert_eq!(saved["relativePath"], "props/lamp.tessel");
    assert_eq!(std::fs::read_to_string(project.0.join("props/lamp.tessel")).unwrap(), "{\"tessel\":1}");
    let escape = block_on(call_with(&ws, &mock, "project_save", json!({ "project": "Survival", "path": "../evil.tessel" }))).unwrap_err();
    assert!(escape.contains("leads out"), "{escape}");

    let opened = block_on(call_with(&ws, &mock, "project_open", json!({ "project": "Survival", "path": "models/chair.tessel" }))).unwrap();
    assert_eq!(opened["opened"], true);
    let load = &mock.calls_of("document.load")[0];
    assert!(load["filePath"].as_str().unwrap().ends_with("chair.tessel"));

    assert!(block_on(call_with(&ws, &mock, "git_status", json!({ "project": "Nope" }))).unwrap_err().contains("Survival"));
    let status = block_on(call_with(&ws, &mock, "git_status", json!({ "project": "Survival" }))).unwrap();
    assert_eq!(status["isRepo"], false);
  }

  #[test]
  fn git_tools_commit_and_push_without_exposing_anything() {
    let (_config, project, ws) = setup("ws-git");
    let mock = Mock::new();
    let remote = project.0.join("..").join(format!("tessel-test-{}-ws-git-remote.git", std::process::id()));
    git2::Repository::init_bare(&remote).unwrap();
    let repo = git2::Repository::init(&project.0).unwrap();
    repo.remote("origin", &remote.to_string_lossy()).unwrap();
    std::fs::write(project.0.join("chair.tessel"), "{}").unwrap();

    let status = block_on(call_with(&ws, &mock, "git_status", json!({ "project": "Survival" }))).unwrap();
    assert_eq!(status["files"][0]["status"], "new");
    let committed = block_on(call_with(&ws, &mock, "git_commit", json!({ "project": "Survival", "message": "Add chair" }))).unwrap();
    assert_eq!(committed["files"], 1);
    let pushed = block_on(call_with(&ws, &mock, "git_push", json!({ "project": "Survival" }))).unwrap();
    assert_eq!(pushed["pushed"], true);
    let pulled = block_on(call_with(&ws, &mock, "git_pull", json!({ "project": "Survival" }))).unwrap();
    assert_eq!(pulled["result"], "up-to-date");
    let _ = std::fs::remove_dir_all(&remote);
  }
}
