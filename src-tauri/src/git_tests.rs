use super::*;
use crate::testing::TempDir;

const ME: (&str, &str) = ("Tester", "tester@example.com");

fn identity() -> Identity {
  (ME.0.to_string(), ME.1.to_string())
}

/// A bare "remote" and two clones of it, as two team members would have them.
struct Team {
  _dir: TempDir,
  remote: String,
  alice: std::path::PathBuf,
  bob: std::path::PathBuf,
}

fn team(name: &str) -> Team {
  let dir = TempDir::new(name);
  let remote = dir.0.join("remote.git");
  Repository::init_bare(&remote).unwrap();
  let remote = remote.to_string_lossy().into_owned();
  let alice = dir.0.join("alice");
  clone(&remote, &alice, None).unwrap();
  std::fs::write(alice.join("chair.tessel"), "{\"v\":1}").unwrap();
  commit(&alice, "Add chair", None, Some(&identity())).unwrap();
  push(&alice, None).unwrap();
  let bob = dir.0.join("bob");
  clone(&remote, &bob, None).unwrap();
  Team { _dir: dir, remote, alice, bob }
}

fn write(path: &std::path::Path, name: &str, text: &str) {
  let file = path.join(name);
  std::fs::create_dir_all(file.parent().unwrap()).unwrap();
  std::fs::write(file, text).unwrap();
}

#[test]
fn status_reports_branch_and_changed_files() {
  let team = team("git-status");
  let status = status(&team.alice).unwrap();
  assert!(status.is_repo);
  assert!(status.branch.is_some());
  assert_eq!(status.state, "clean");
  assert_eq!((status.ahead, status.behind), (0, 0));
  assert!(status.files.is_empty());
  assert_eq!(origin_url(&team.alice).as_deref(), Some(team.remote.as_str()));

  write(&team.alice, "chair.tessel", "{\"v\":2}");
  write(&team.alice, "assets/survival/textures/oak.png", "png");
  let status = super::status(&team.alice).unwrap();
  let files: Vec<(&str, &str)> = status.files.iter().map(|f| (f.path.as_str(), f.status)).collect();
  assert_eq!(files, [("assets/survival/textures/oak.png", "new"), ("chair.tessel", "modified")]);

  let map = status_map(&team.alice);
  assert_eq!(map.get("chair.tessel").map(String::as_str), Some("modified"));
  assert_eq!(map.get("assets").map(String::as_str), Some("new"));
  assert_eq!(map.get("assets/survival/textures").map(String::as_str), Some("new"));

  let plain = TempDir::new("git-status-plain");
  assert!(!super::status(&plain.0).unwrap().is_repo);
  assert!(status_map(&plain.0).is_empty());
}

#[test]
fn commit_takes_chosen_files_or_everything() {
  let team = team("git-commit");
  write(&team.alice, "a.tessel", "a");
  write(&team.alice, "b.tessel", "b");
  assert!(commit(&team.alice, "  ", None, None).is_err());
  let result = commit(&team.alice, "Add a", Some(&["a.tessel".to_string()]), Some(&identity())).unwrap();
  assert_eq!(result.files, 1);
  let left: Vec<String> = status(&team.alice).unwrap().files.into_iter().map(|f| f.path).collect();
  assert_eq!(left, ["b.tessel"]);
  assert!(commit(&team.alice, "x", Some(&["../escape.tessel".to_string()]), None).is_err());

  std::fs::remove_file(team.alice.join("chair.tessel")).unwrap();
  let result = commit(&team.alice, "Everything", None, Some(&identity())).unwrap();
  assert_eq!(result.files, 2, "b.tessel added, chair.tessel deleted");
  assert!(status(&team.alice).unwrap().files.is_empty());
  assert!(commit(&team.alice, "Nothing", None, None).unwrap_err().contains("nothing to commit"));
  assert_eq!(status(&team.alice).unwrap().ahead, 2);
}

#[test]
fn pull_fast_forwards_and_merges() {
  let team = team("git-pull");
  write(&team.alice, "table.tessel", "t");
  commit(&team.alice, "Add table", None, Some(&identity())).unwrap();
  push(&team.alice, None).unwrap();

  let pulled = pull(&team.bob, None, Some(&identity())).unwrap();
  assert_eq!(pulled.result, "fast-forward");
  assert!(team.bob.join("table.tessel").is_file());
  assert_eq!(pull(&team.bob, None, None).unwrap().result, "up-to-date");

  // Different files on both sides: merged without asking.
  write(&team.alice, "lamp.tessel", "l");
  commit(&team.alice, "Add lamp", None, Some(&identity())).unwrap();
  push(&team.alice, None).unwrap();
  write(&team.bob, "bed.tessel", "b");
  commit(&team.bob, "Add bed", None, Some(&identity())).unwrap();
  let rejected = push(&team.bob, None).unwrap_err();
  assert!(rejected.contains("Pull first"), "{rejected}");
  assert_eq!(pull(&team.bob, None, Some(&identity())).unwrap().result, "merged");
  assert!(team.bob.join("lamp.tessel").is_file() && team.bob.join("bed.tessel").is_file());
  push(&team.bob, None).unwrap();
  assert_eq!(pull(&team.alice, None, None).unwrap().result, "fast-forward");
}

#[test]
fn conflicts_and_uncommitted_changes_leave_everything_as_it_was() {
  let team = team("git-conflict");
  write(&team.alice, "chair.tessel", "{\"v\":\"alice\"}");
  commit(&team.alice, "Alice's chair", None, Some(&identity())).unwrap();
  push(&team.alice, None).unwrap();

  // Bob changed the same file without committing: the pull must not overwrite it.
  write(&team.bob, "chair.tessel", "{\"v\":\"bob\"}");
  let error = pull(&team.bob, None, Some(&identity())).unwrap_err();
  assert!(error.contains("uncommitted changes"), "{error}");
  assert_eq!(std::fs::read_to_string(team.bob.join("chair.tessel")).unwrap(), "{\"v\":\"bob\"}");

  // Bob commits: now both changed the file.
  commit(&team.bob, "Bob's chair", None, Some(&identity())).unwrap();
  let head_before = Repository::open(&team.bob).unwrap().head().unwrap().target();
  let error = pull(&team.bob, None, Some(&identity())).unwrap_err();
  assert!(error.contains("chair.tessel") && error.contains("Nothing was changed"), "{error}");
  let repo = Repository::open(&team.bob).unwrap();
  assert_eq!(repo.head().unwrap().target(), head_before);
  assert_eq!(repo.state(), RepositoryState::Clean);
  assert_eq!(std::fs::read_to_string(team.bob.join("chair.tessel")).unwrap(), "{\"v\":\"bob\"}");
  let status = status(&team.bob).unwrap();
  assert_eq!((status.ahead, status.behind), (1, 1));
}

#[test]
fn branches_are_listed_and_switched() {
  let team = team("git-branches");
  let repo = Repository::open(&team.alice).unwrap();
  let head = repo.head().unwrap().peel_to_commit().unwrap();
  repo.branch("textures", &head, false).unwrap();
  switch_branch(&team.alice, "textures").unwrap();
  write(&team.alice, "oak.png", "png");
  commit(&team.alice, "Oak", None, Some(&identity())).unwrap();
  push(&team.alice, None).unwrap();

  pull(&team.bob, None, None).unwrap();
  // Bob does not have the branch locally yet, only after a fetch; pull fetches the current branch only.
  let bob_repo = Repository::open(&team.bob).unwrap();
  let mut remote = bob_repo.find_remote("origin").unwrap();
  remote.fetch(&["+refs/heads/*:refs/remotes/origin/*"], None, None).unwrap();
  let listed = branches(&team.bob).unwrap();
  assert!(listed.remote.contains(&"textures".to_string()), "{listed:?}");
  switch_branch(&team.bob, "textures").unwrap();
  assert!(team.bob.join("oak.png").is_file());
  assert_eq!(status(&team.bob).unwrap().branch.as_deref(), Some("textures"));
  assert!(branches(&team.bob).unwrap().local.contains(&"textures".to_string()));
  assert!(switch_branch(&team.bob, "missing").unwrap_err().contains("no branch"));

  // Switching away with an uncommitted change to a file the other branch has differently is refused.
  write(&team.bob, "oak.png", "changed");
  let main = listed.current.unwrap();
  let error = switch_branch(&team.bob, &main).unwrap_err();
  assert!(error.contains("uncommitted"), "{error}");
}

#[test]
fn clone_refuses_a_folder_that_is_in_use() {
  let team = team("git-clone");
  assert!(clone(&team.remote, &team.alice, None).unwrap_err().contains("not empty"));
}

#[test]
fn remote_errors_are_explained() {
  let auth = git2::Error::new(ErrorCode::Auth, ErrorClass::Http, "authentication required");
  assert!(remote_error(auth, "push").contains("Sign in to GitHub"));
  let behind = git2::Error::new(ErrorCode::NotFastForward, ErrorClass::Reference, "cannot push non-fastforwardable reference");
  assert!(remote_error(behind, "push").contains("Pull first"));
  let offline = git2::Error::new(ErrorCode::GenericError, ErrorClass::Net, "failed to resolve address");
  assert!(remote_error(offline, "pull").contains("no connection"));
}
