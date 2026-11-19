use super::*;
use crate::testing::{TempDir, block_on};

#[test]
fn relative_paths_cannot_leave_the_project() {
  assert_eq!(relative_components("models/chair.tessel").unwrap(), ["models", "chair.tessel"]);
  assert_eq!(relative_components("models\\.\\chair.tessel").unwrap(), ["models", "chair.tessel"]);
  assert_eq!(relative_components("").unwrap(), Vec::<String>::new());
  assert_eq!(relative_components("assets/minecraft/textures/block").unwrap().len(), 4);
  for bad in [
    "../secret.tessel",
    "models/../../x.json",
    "..\\x.png",
    "/etc/passwd",
    "\\Windows\\x.png",
    "C:\\Windows\\x.png",
    "C:x.png",
    "file.png:stream",
    ".git/config",
    "sub/.GIT/hooks/x.json",
    "con.png",
    "name.",
    "a\u{0}b.png",
  ] {
    assert!(relative_components(bad).is_err(), "{bad} should be rejected");
  }
}

#[test]
fn resolve_stays_inside_the_root() {
  let dir = TempDir::new("projects-resolve");
  std::fs::create_dir_all(dir.0.join("models")).unwrap();
  let resolved = resolve(&dir.0, "models/new/chair.tessel").unwrap();
  assert!(resolved.starts_with(&dir.0));
  assert!(resolve(&dir.0, "../outside.tessel").is_err());
}

#[cfg(unix)]
#[test]
fn symbolic_links_out_of_the_project_are_refused() {
  let dir = TempDir::new("projects-symlink");
  let outside = TempDir::new("projects-symlink-outside");
  std::os::unix::fs::symlink(&outside.0, dir.0.join("link")).unwrap();
  assert!(resolve(&dir.0, "link/evil.tessel").unwrap_err().contains("leads out"));
}

#[test]
fn absolute_paths_inside_the_project_become_relative() {
  let dir = TempDir::new("projects-relative");
  std::fs::create_dir_all(dir.0.join("models")).unwrap();
  let inside = dir.0.join("models").join("chair.tessel");
  assert_eq!(to_relative(&dir.0, &inside.to_string_lossy()).unwrap(), "models/chair.tessel");
  assert_eq!(to_relative(&dir.0, "models\\chair.tessel").unwrap(), "models/chair.tessel");
  let outside = TempDir::new("projects-relative-outside");
  assert!(to_relative(&dir.0, &outside.path("x.tessel")).is_err());
}

#[test]
fn the_project_list_is_persisted() {
  let config = TempDir::new("projects-registry-config");
  let survival = TempDir::new("projects-registry-survival");
  let factory = TempDir::new("projects-registry-factory");
  let file = config.0.join("projects.json");

  let registry = Registry::load(file.clone());
  assert!(registry.list().is_empty());
  let first = registry.add(&survival.0.to_string_lossy(), Some("Survival Server"), None).unwrap();
  let second = registry.add(&factory.0.to_string_lossy(), None, Some("https://github.com/team/factory.git".into())).unwrap();
  assert_ne!(first.id, second.id);
  assert!(second.name.ends_with("projects-registry-factory"));
  // Adding the same folder again returns the registered project.
  assert_eq!(registry.add(&survival.0.to_string_lossy(), Some("Other"), None).unwrap().id, first.id);
  assert!(registry.add("relative/path", None, None).is_err());
  assert!(registry.add(&survival.path("missing"), None, None).is_err());

  let reloaded = Registry::load(file.clone());
  assert_eq!(reloaded.list(), registry.list());
  assert_eq!(reloaded.find("survival server").unwrap().id, first.id);
  assert_eq!(reloaded.find(&second.id).unwrap().remote.as_deref(), Some("https://github.com/team/factory.git"));
  assert_eq!(reloaded.find(&factory.0.to_string_lossy()).unwrap().id, second.id);
  assert!(reloaded.find("nope").unwrap_err().contains("Survival Server"));

  reloaded.rename(&first.id, "Survival").unwrap();
  reloaded.remove(&second.id).unwrap();
  assert!(reloaded.remove(&second.id).is_err());
  let again = Registry::load(file.clone());
  assert_eq!(again.list().len(), 1);
  assert_eq!(again.list()[0].name, "Survival");
  // The folder itself is untouched.
  assert!(factory.0.is_dir());

  // A broken file is an empty list rather than an error.
  std::fs::write(&file, "not json").unwrap();
  assert!(Registry::load(file).list().is_empty());
}

#[test]
fn files_are_listed_written_renamed_and_read() {
  let dir = TempDir::new("projects-files");
  let root = dir.0.as_path();
  block_on(async {
    write_bytes(root, "models/chair.tessel", b"{}").await.unwrap();
    write_bytes(root, "assets/survival/textures/block/oak.png", &[1, 2, 3]).await.unwrap();
    assert!(write_bytes(root, "run.exe", b"").await.unwrap_err().contains("must end in"));
    assert!(write_bytes(root, "../escape.tessel", b"").await.is_err());
    assert_eq!(read_text(root, "models/chair.tessel").await.unwrap(), "{}");
    assert_eq!(read_bytes(root, "assets/survival/textures/block/oak.png").await.unwrap(), [1, 2, 3]);
  });
  std::fs::write(root.join("notes.txt"), "x").unwrap();
  std::fs::create_dir_all(root.join(".git")).unwrap();

  let top = list_dir(root, "").unwrap();
  let names: Vec<&str> = top.iter().map(|e| e.name.as_str()).collect();
  assert_eq!(names, ["assets", "models"], "folders first, hidden and foreign files left out");
  let models = list_dir(root, "models").unwrap();
  assert_eq!(models[0].path, "models/chair.tessel");
  assert_eq!(models[0].kind, "file");
  assert_eq!(models[0].size, 2);

  let (all, truncated) = list_files(root, "").unwrap();
  assert!(!truncated);
  let paths: Vec<&str> = all.iter().map(|e| e.path.as_str()).collect();
  assert_eq!(paths, ["assets/survival/textures/block/oak.png", "models/chair.tessel"]);

  create_dir(root, "models/props").unwrap();
  assert!(create_dir(root, "models/props").is_err());
  rename(root, "models/chair.tessel", "models/props/stool.tessel").unwrap();
  assert!(root.join("models/props/stool.tessel").is_file());
  assert!(rename(root, "models/props/stool.tessel", "models/props/stool.exe").is_err());
  assert!(rename(root, "models/missing.tessel", "models/x.tessel").is_err());
  assert!(rename(root, "", "x").is_err());
  assert!(delete(root, "").is_err());
  assert!(delete(root, "../x.tessel").is_err());
}
