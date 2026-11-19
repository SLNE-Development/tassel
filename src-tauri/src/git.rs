//! Git for projects, through libgit2 (the `git2` crate, built in): no separate git installation is
//! needed. HTTPS remotes on github.com authenticate with the GitHub token of the signed-in account,
//! which the caller passes in and which never leaves this module.
//!
//! Every function here blocks; the commands run them on a blocking thread.

use std::collections::HashMap;
use std::path::Path;

use git2::build::{CheckoutBuilder, RepoBuilder};
use git2::{
  BranchType, Cred, ErrorClass, ErrorCode, FetchOptions, IndexAddOption, PushOptions, RemoteCallbacks, Repository,
  RepositoryState, Signature, Status, StatusOptions,
};
use serde::Serialize;

/// Name and e-mail for commits when the repository and the user's git config have none.
pub type Identity = (String, String);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
  /// Relative to the repository root, `/`-separated.
  pub path: String,
  /// `new`, `modified`, `deleted`, `renamed`, `typechange` or `conflicted`.
  pub status: &'static str,
  /// Whether the change is already staged.
  pub staged: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
  pub is_repo: bool,
  /// Current branch; None when HEAD is detached or the folder is no repository.
  pub branch: Option<String>,
  pub detached: bool,
  /// `origin/<branch>` when it exists.
  pub upstream: Option<String>,
  /// Commits on the branch that the remote does not have yet.
  pub ahead: usize,
  /// Commits on the remote that the branch does not have yet (as of the last pull or fetch).
  pub behind: usize,
  pub remote: Option<String>,
  /// `clean` or an unfinished operation (`merge`, `rebase`, ...).
  pub state: &'static str,
  pub files: Vec<FileStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branches {
  pub current: Option<String>,
  pub local: Vec<String>,
  /// Branches of `origin` that have no local branch yet (switching to one creates it).
  pub remote: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
  pub commit: String,
  pub branch: Option<String>,
  pub files: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullResult {
  /// `up-to-date`, `fast-forward` or `merged`.
  pub result: &'static str,
  pub branch: String,
  pub commit: Option<String>,
}

pub fn open(path: &Path) -> Result<Repository, String> {
  Repository::open(path).map_err(|_| format!("\"{}\" is not a git repository", path.display()))
}

/// URL of the `origin` remote.
pub fn origin_url(path: &Path) -> Option<String> {
  let repo = Repository::open(path).ok()?;
  let remote = repo.find_remote("origin").ok()?;
  remote.url().map(str::to_string)
}

fn status_name(status: Status) -> Option<(&'static str, bool)> {
  if status.is_conflicted() {
    return Some(("conflicted", false));
  }
  let staged = status.intersects(Status::INDEX_NEW | Status::INDEX_MODIFIED | Status::INDEX_DELETED | Status::INDEX_RENAMED | Status::INDEX_TYPECHANGE);
  let name = if status.intersects(Status::WT_NEW | Status::INDEX_NEW) {
    "new"
  } else if status.intersects(Status::WT_DELETED | Status::INDEX_DELETED) {
    "deleted"
  } else if status.intersects(Status::WT_RENAMED | Status::INDEX_RENAMED) {
    "renamed"
  } else if status.intersects(Status::WT_TYPECHANGE | Status::INDEX_TYPECHANGE) {
    "typechange"
  } else if status.intersects(Status::WT_MODIFIED | Status::INDEX_MODIFIED) {
    "modified"
  } else {
    return None;
  };
  Some((name, staged))
}

fn changed_files(repo: &Repository) -> Result<Vec<FileStatus>, String> {
  let mut options = StatusOptions::new();
  options.include_untracked(true).recurse_untracked_dirs(true).renames_head_to_index(true).include_ignored(false);
  let statuses = repo.statuses(Some(&mut options)).map_err(describe)?;
  let mut files: Vec<FileStatus> = statuses
    .iter()
    .filter_map(|entry| {
      let path = entry.path()?.to_string();
      let (status, staged) = status_name(entry.status())?;
      Some(FileStatus { path, status, staged })
    })
    .collect();
  files.sort_by(|a, b| a.path.cmp(&b.path));
  Ok(files)
}

/// Git status of every changed file by path, plus every folder that contains a change (as `modified`,
/// or `new` when everything changed inside it is new). Empty when the folder is no repository.
pub fn status_map(path: &Path) -> HashMap<String, String> {
  let mut map = HashMap::new();
  let Ok(repo) = Repository::open(path) else { return map };
  let Ok(files) = changed_files(&repo) else { return map };
  for file in files {
    let mut folder = file.path.as_str();
    while let Some(slash) = folder.rfind('/') {
      folder = &folder[..slash];
      let entry = map.entry(folder.to_string()).or_insert_with(|| file.status.to_string());
      if entry != file.status {
        *entry = "modified".into();
      }
    }
    map.insert(file.path.clone(), file.status.to_string());
  }
  map
}

fn current_branch(repo: &Repository) -> (Option<String>, bool) {
  match repo.head() {
    Ok(head) if head.is_branch() => (head.shorthand().map(str::to_string), false),
    Ok(_) => (None, true),
    // An unborn branch (a new repository without commits): HEAD names it already.
    Err(_) => {
      let name = repo
        .find_reference("HEAD")
        .ok()
        .and_then(|head| head.symbolic_target().map(str::to_string))
        .and_then(|target| target.strip_prefix("refs/heads/").map(str::to_string));
      (name, false)
    }
  }
}

fn state_name(state: RepositoryState) -> &'static str {
  match state {
    RepositoryState::Clean => "clean",
    RepositoryState::Merge => "merge",
    RepositoryState::Revert | RepositoryState::RevertSequence => "revert",
    RepositoryState::CherryPick | RepositoryState::CherryPickSequence => "cherry-pick",
    RepositoryState::Bisect => "bisect",
    RepositoryState::Rebase | RepositoryState::RebaseInteractive | RepositoryState::RebaseMerge => "rebase",
    RepositoryState::ApplyMailbox | RepositoryState::ApplyMailboxOrRebase => "apply-mailbox",
  }
}

pub fn status(path: &Path) -> Result<RepoStatus, String> {
  let Ok(repo) = Repository::open(path) else {
    return Ok(RepoStatus {
      is_repo: false,
      branch: None,
      detached: false,
      upstream: None,
      ahead: 0,
      behind: 0,
      remote: None,
      state: "clean",
      files: Vec::new(),
    });
  };
  let (branch, detached) = current_branch(&repo);
  let mut upstream = None;
  let (mut ahead, mut behind) = (0, 0);
  if let Some(name) = &branch {
    let remote_ref = format!("refs/remotes/origin/{name}");
    if let (Ok(local), Ok(remote)) = (repo.refname_to_id(&format!("refs/heads/{name}")), repo.refname_to_id(&remote_ref)) {
      upstream = Some(format!("origin/{name}"));
      (ahead, behind) = repo.graph_ahead_behind(local, remote).map_err(describe)?;
    } else if repo.refname_to_id(&remote_ref).is_ok() {
      upstream = Some(format!("origin/{name}"));
    }
  }
  Ok(RepoStatus {
    is_repo: true,
    branch,
    detached,
    upstream,
    ahead,
    behind,
    remote: origin_url(path),
    state: state_name(repo.state()),
    files: changed_files(&repo)?,
  })
}

pub fn branches(path: &Path) -> Result<Branches, String> {
  let repo = open(path)?;
  let (current, _) = current_branch(&repo);
  let mut local = Vec::new();
  for branch in repo.branches(Some(BranchType::Local)).map_err(describe)? {
    let (branch, _) = branch.map_err(describe)?;
    if let Some(name) = branch.name().map_err(describe)? {
      local.push(name.to_string());
    }
  }
  if let Some(name) = &current
    && !local.contains(name)
  {
    local.push(name.clone());
  }
  let mut remote = Vec::new();
  for branch in repo.branches(Some(BranchType::Remote)).map_err(describe)? {
    let (branch, _) = branch.map_err(describe)?;
    if let Some(name) = branch.name().map_err(describe)?
      && let Some(short) = name.strip_prefix("origin/")
      && short != "HEAD"
      && !local.iter().any(|l| l == short)
    {
      remote.push(short.to_string());
    }
  }
  local.sort();
  remote.sort();
  Ok(Branches { current, local, remote })
}

/// Switches to a local branch, or creates one that tracks `origin/<name>`. Refuses when uncommitted
/// changes would be overwritten.
pub fn switch_branch(path: &Path, name: &str) -> Result<String, String> {
  let repo = open(path)?;
  let name = name.trim();
  let local = match repo.find_branch(name, BranchType::Local) {
    Ok(branch) => branch,
    Err(_) => {
      let remote = repo
        .find_branch(&format!("origin/{name}"), BranchType::Remote)
        .map_err(|_| format!("There is no branch \"{name}\""))?;
      let commit = remote.get().peel_to_commit().map_err(describe)?;
      let mut branch = repo.branch(name, &commit, false).map_err(describe)?;
      branch.set_upstream(Some(&format!("origin/{name}"))).map_err(describe)?;
      branch
    }
  };
  let reference = local.get().name().ok_or("The branch name is not valid UTF-8")?.to_string();
  let tree = local.get().peel_to_tree().map_err(describe)?;
  repo
    .checkout_tree(tree.as_object(), Some(CheckoutBuilder::new().safe()))
    .map_err(|e| checkout_error(e, "switch branches"))?;
  repo.set_head(&reference).map_err(describe)?;
  Ok(name.to_string())
}

fn signature(repo: &Repository, fallback: Option<&Identity>) -> Result<Signature<'static>, String> {
  if let Ok(signature) = repo.signature() {
    return Ok(signature.to_owned());
  }
  let (name, email) = fallback.cloned().unwrap_or_else(|| ("Tessel".into(), "tessel@localhost".into()));
  Signature::now(&name, &email).map_err(describe)
}

/// Commits the given files (relative to the repository, deletions included) or, without a list,
/// every change. Returns an error when there is nothing to commit.
pub fn commit(path: &Path, message: &str, files: Option<&[String]>, identity: Option<&Identity>) -> Result<CommitResult, String> {
  let message = message.trim();
  if message.is_empty() {
    return Err("The commit message must not be empty".into());
  }
  let repo = open(path)?;
  if repo.state() != RepositoryState::Clean {
    return Err(format!("The repository is in the middle of a {}; finish it with another git tool first", state_name(repo.state())));
  }
  let mut index = repo.index().map_err(describe)?;
  match files {
    None => {
      index.add_all(["*"], IndexAddOption::DEFAULT, None).map_err(describe)?;
      index.update_all(["*"], None).map_err(describe)?;
    }
    Some(files) => {
      if files.is_empty() {
        return Err("No files were chosen for the commit".into());
      }
      for file in files {
        let relative = crate::projects::relative_components(file)?.join("/");
        if path.join(&relative).exists() {
          index.add_path(Path::new(&relative)).map_err(describe)?;
        } else {
          index.remove_path(Path::new(&relative)).map_err(describe)?;
        }
      }
    }
  }
  index.write().map_err(describe)?;
  let tree_id = index.write_tree().map_err(describe)?;
  let tree = repo.find_tree(tree_id).map_err(describe)?;
  let parent = repo.head().ok().and_then(|head| head.peel_to_commit().ok());
  if let Some(parent) = &parent
    && parent.tree_id() == tree_id
  {
    return Err("There is nothing to commit: the chosen files have no changes".into());
  }
  if parent.is_none() && tree.is_empty() {
    return Err("There is nothing to commit".into());
  }
  let changed = match &parent {
    Some(parent) => {
      let old = parent.tree().map_err(describe)?;
      repo.diff_tree_to_tree(Some(&old), Some(&tree), None).map_err(describe)?.deltas().len()
    }
    None => tree.len(),
  };
  let signature = signature(&repo, identity)?;
  let parents: Vec<&git2::Commit> = parent.iter().collect();
  let id = repo.commit(Some("HEAD"), &signature, &signature, message, &tree, &parents).map_err(describe)?;
  let (branch, _) = current_branch(&repo);
  Ok(CommitResult { commit: id.to_string(), branch, files: changed })
}

/// Credentials for remote operations: the token for github.com over HTTPS, nothing otherwise.
/// libgit2 asks again after a rejected attempt; the second ask fails so it does not loop.
fn callbacks(token: Option<&str>) -> RemoteCallbacks<'_> {
  let mut callbacks = RemoteCallbacks::new();
  let mut asked = false;
  callbacks.credentials(move |url, _username, _allowed| {
    let github = url.starts_with("https://github.com/") || url.starts_with("https://www.github.com/");
    if asked || !github {
      return Err(git2::Error::new(ErrorCode::Auth, ErrorClass::Http, "authentication required"));
    }
    asked = true;
    match token {
      Some(token) => Cred::userpass_plaintext("x-access-token", token),
      None => Err(git2::Error::new(ErrorCode::Auth, ErrorClass::Http, "not signed in to GitHub")),
    }
  });
  callbacks
}

fn fetch_options(token: Option<&str>) -> FetchOptions<'_> {
  let mut options = FetchOptions::new();
  options.remote_callbacks(callbacks(token));
  options
}

/// Clones `url` into `destination` (which must not exist or be empty).
pub fn clone(url: &str, destination: &Path, token: Option<&str>) -> Result<(), String> {
  if destination.exists() && std::fs::read_dir(destination).map(|mut d| d.next().is_some()).unwrap_or(true) {
    return Err(format!("\"{}\" already exists and is not empty", destination.display()));
  }
  RepoBuilder::new()
    .fetch_options(fetch_options(token))
    .clone(url, destination)
    .map(drop)
    .map_err(|e| remote_error(e, "clone"))
}

/// Fetches every branch of `origin` (so other branches can be switched to), without changing files.
pub fn fetch_all(path: &Path, token: Option<&str>) -> Result<(), String> {
  let repo = open(path)?;
  let mut remote = repo.find_remote("origin").map_err(|_| "The project has no remote called \"origin\"".to_string())?;
  remote
    .fetch(&["+refs/heads/*:refs/remotes/origin/*"], Some(&mut fetch_options(token)), None)
    .map_err(|e| remote_error(e, "fetch"))
}

/// Fetches the current branch from `origin` and brings it up to date: fast-forward when possible,
/// otherwise a merge commit. Nothing changes when both sides edited the same files or uncommitted
/// changes would be overwritten; the error says which files.
pub fn pull(path: &Path, token: Option<&str>, identity: Option<&Identity>) -> Result<PullResult, String> {
  let repo = open(path)?;
  if repo.state() != RepositoryState::Clean {
    return Err(format!("The repository is in the middle of a {}; finish it with another git tool first", state_name(repo.state())));
  }
  let (branch, detached) = current_branch(&repo);
  let branch = match (branch, detached) {
    (Some(branch), false) => branch,
    _ => return Err("No branch is checked out; switch to a branch first".into()),
  };
  let mut remote = repo.find_remote("origin").map_err(|_| "The project has no remote called \"origin\"".to_string())?;
  let refspec = format!("+refs/heads/{branch}:refs/remotes/origin/{branch}");
  remote.fetch(&[refspec.as_str()], Some(&mut fetch_options(token)), None).map_err(|e| remote_error(e, "pull"))?;
  drop(remote);

  let Ok(theirs_id) = repo.refname_to_id(&format!("refs/remotes/origin/{branch}")) else {
    return Ok(PullResult { result: "up-to-date", branch, commit: None });
  };
  let theirs = repo.find_commit(theirs_id).map_err(describe)?;
  let local_ref = format!("refs/heads/{branch}");
  let ours = repo.head().ok().and_then(|head| head.peel_to_commit().ok());

  let Some(ours) = ours else {
    // A repository without commits takes over the remote branch.
    checkout_commit(&repo, &theirs, "pull")?;
    repo.reference(&local_ref, theirs_id, true, "pull: initial").map_err(describe)?;
    repo.set_head(&local_ref).map_err(describe)?;
    return Ok(PullResult { result: "fast-forward", branch, commit: Some(theirs_id.to_string()) });
  };
  if ours.id() == theirs_id || repo.graph_descendant_of(ours.id(), theirs_id).map_err(describe)? {
    return Ok(PullResult { result: "up-to-date", branch, commit: Some(ours.id().to_string()) });
  }
  if repo.graph_descendant_of(theirs_id, ours.id()).map_err(describe)? {
    checkout_commit(&repo, &theirs, "pull")?;
    repo.reference(&local_ref, theirs_id, true, "pull: fast-forward").map_err(describe)?;
    return Ok(PullResult { result: "fast-forward", branch, commit: Some(theirs_id.to_string()) });
  }

  // Both sides have new commits: merge in memory first, so a conflict changes nothing on disk.
  let mut merged = repo.merge_commits(&ours, &theirs, None).map_err(describe)?;
  if merged.has_conflicts() {
    let mut files: Vec<String> = merged
      .conflicts()
      .map_err(describe)?
      .flatten()
      .filter_map(|c| c.our.or(c.their).or(c.ancestor).map(|e| String::from_utf8_lossy(&e.path).into_owned()))
      .collect();
    files.sort();
    files.dedup();
    return Err(format!(
      "Pull stopped because you and someone else both changed {}. Nothing was changed. Keep your version by \
       renaming your file, committing, pulling and then putting your changes back, or discard your commit.",
      files.join(", ")
    ));
  }
  let tree_id = merged.write_tree_to(&repo).map_err(describe)?;
  let tree = repo.find_tree(tree_id).map_err(describe)?;
  let signature = signature(&repo, identity)?;
  let message = format!("Merge remote-tracking branch 'origin/{branch}'");
  let id = repo.commit(None, &signature, &signature, &message, &tree, &[&ours, &theirs]).map_err(describe)?;
  let commit = repo.find_commit(id).map_err(describe)?;
  checkout_commit(&repo, &commit, "pull")?;
  repo.reference(&local_ref, id, true, "pull: merge").map_err(describe)?;
  Ok(PullResult { result: "merged", branch, commit: Some(id.to_string()) })
}

fn checkout_commit(repo: &Repository, commit: &git2::Commit, action: &str) -> Result<(), String> {
  repo
    .checkout_tree(commit.as_object(), Some(CheckoutBuilder::new().safe()))
    .map_err(|e| checkout_error(e, action))
}

/// Pushes the current branch to `origin` (creating it there if needed).
pub fn push(path: &Path, token: Option<&str>) -> Result<String, String> {
  let repo = open(path)?;
  let (branch, detached) = current_branch(&repo);
  let branch = match (branch, detached) {
    (Some(branch), false) => branch,
    _ => return Err("No branch is checked out; switch to a branch first".into()),
  };
  if repo.head().is_err() {
    return Err("There are no commits to push yet".into());
  }
  let mut remote = repo.find_remote("origin").map_err(|_| "The project has no remote called \"origin\"".to_string())?;
  let mut rejected: Option<String> = None;
  {
    let mut callbacks = callbacks(token);
    callbacks.push_update_reference(|_reference, status| {
      if let Some(status) = status {
        rejected = Some(status.to_string());
      }
      Ok(())
    });
    let mut options = PushOptions::new();
    options.remote_callbacks(callbacks);
    let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
    remote.push(&[refspec.as_str()], Some(&mut options)).map_err(|e| remote_error(e, "push"))?;
  }
  if let Some(reason) = rejected {
    return Err(if reason.contains("fast-forward") || reason.contains("fetch first") {
      "The remote has changes that you do not have yet. Pull first, then push again.".into()
    } else {
      format!("The remote rejected the push: {reason}")
    });
  }
  // Remember what the remote has now, for ahead / behind.
  if let Ok(id) = repo.refname_to_id(&format!("refs/heads/{branch}")) {
    let _ = repo.reference(&format!("refs/remotes/origin/{branch}"), id, true, "push");
  }
  Ok(branch)
}

// ---- errors --------------------------------------------------------------------------------------

fn describe(error: git2::Error) -> String {
  error.message().to_string()
}

fn checkout_error(error: git2::Error, action: &str) -> String {
  if error.code() == ErrorCode::Conflict || error.class() == ErrorClass::Checkout {
    format!(
      "Cannot {action}: you have uncommitted changes to files that would be overwritten ({}). Commit or discard them first.",
      error.message()
    )
  } else {
    describe(error)
  }
}

/// A remote failure in words the user can act on.
fn remote_error(error: git2::Error, action: &str) -> String {
  let message = error.message().to_lowercase();
  if error.code() == ErrorCode::Auth || message.contains("authentication") || message.contains("401") || message.contains("403") {
    format!(
      "GitHub refused access while trying to {action}. Sign in to GitHub in Tessel (Projects panel) with an account \
       that has access to this repository, or sign out and in again if the login expired."
    )
  } else if error.code() == ErrorCode::NotFastForward || message.contains("non-fastforward") || message.contains("not present locally") {
    "The remote has changes that you do not have yet. Pull first, then push again.".into()
  } else if message.contains("not found") || message.contains("404") {
    format!("Could not {action}: the repository was not found (or your account has no access to it).")
  } else if error.class() == ErrorClass::Net || error.class() == ErrorClass::Http || error.class() == ErrorClass::Ssl {
    format!("Could not {action}: no connection to the remote ({}).", error.message())
  } else {
    format!("Could not {action}: {}", error.message())
  }
}

#[cfg(test)]
#[path = "git_tests.rs"]
mod tests;
