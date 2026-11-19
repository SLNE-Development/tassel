use std::io::Write;

use super::*;

/// A fresh empty temp folder, removed on drop.
struct Temp(PathBuf);

impl Temp {
  fn new(name: &str) -> Self {
    let dir = std::env::temp_dir().join(format!("tessel-mcassets-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    Temp(dir)
  }
}

impl Drop for Temp {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.0);
  }
}

const FILES: [(&str, &[u8]); 5] = [
  ("assets/minecraft/textures/block/stone.png", b"\x89PNGstone"),
  ("assets/minecraft/models/block/cube.json", b"{}"),
  ("assets/othermod/textures/x.png", b"x"),
  ("version.json", br#"{"id":"1.21.4","pack_version":{"resource":46}}"#),
  ("net/minecraft/Foo.class", b"class"),
];

fn make_jar(dir: &Path) -> PathBuf {
  let path = dir.join("fake.jar");
  let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
  let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
  for (name, bytes) in FILES {
    zip.start_file(name, options).unwrap();
    zip.write_all(bytes).unwrap();
  }
  zip.finish().unwrap();
  path
}

fn make_folder(dir: &Path) -> PathBuf {
  let root = dir.join("pack");
  for (name, bytes) in FILES {
    let path = root.join(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
  }
  fs::write(root.join("pack.mcmeta"), br#"{"pack":{"pack_format":34}}"#).unwrap();
  root
}

fn check_source(mut source: Source) {
  assert_eq!(source.read("assets/minecraft/textures/block/stone.png").unwrap().unwrap(), b"\x89PNGstone");
  assert_eq!(source.read("assets/minecraft/textures/block/nope.png").unwrap(), None);
  assert_eq!(source.read("assets/nothing/x.png").unwrap(), None);
  for bad in ["../x", "assets/../x", "/assets/x", "C:/x", "assets\\x", "net/minecraft/Foo.class", "assets//x", "assets/./x", ""] {
    assert!(source.read(bad).is_err(), "{bad} should be rejected");
  }
  let list = source.list("assets/minecraft/").unwrap();
  assert_eq!(list, vec!["assets/minecraft/models/block/cube.json", "assets/minecraft/textures/block/stone.png"]);
  assert_eq!(source.list("assets").unwrap().len(), 3);
  assert!(source.list("assets/minecraft/zzz").unwrap().is_empty());
  assert!(source.list("net").is_err());
  assert!(source.list("assets/../x").is_err());
}

#[test]
fn jar_source() {
  let tmp = Temp::new("jar");
  let source = Source::open(&make_jar(&tmp.0)).unwrap();
  let info = source.info();
  assert_eq!(info.kind, "jar");
  assert_eq!(info.namespaces, vec!["minecraft", "othermod"]);
  assert_eq!(info.version.as_deref(), Some("1.21.4"));
  assert_eq!(info.pack_format, Some(46));
  assert!(serde_json::to_string(&info).unwrap().contains("packFormat"));
  check_source(source);
}

#[test]
fn jar_without_assets_is_rejected() {
  let tmp = Temp::new("noassets");
  let path = tmp.0.join("empty.zip");
  let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
  zip.start_file("a.txt", zip::write::SimpleFileOptions::default()).unwrap();
  zip.finish().unwrap();
  assert!(Source::open(&path).is_err());
  assert!(Source::open(&tmp.0.join("missing.jar")).is_err());
}

#[test]
fn folder_source_by_root_and_assets_dir() {
  let tmp = Temp::new("folder");
  let root = make_folder(&tmp.0);
  let source = Source::open(&root).unwrap();
  let info = source.info();
  assert_eq!(info.kind, "folder");
  assert_eq!(info.namespaces, vec!["minecraft", "othermod"]);
  assert_eq!(info.pack_format, Some(34));
  assert_eq!(info.version.as_deref(), Some("1.21.4"));
  check_source(source);

  let by_assets = Source::open(&root.join("assets")).unwrap();
  assert_eq!(by_assets.info().path, root.to_string_lossy());
  check_source(by_assets);

  assert!(Source::open(&root.join("assets/minecraft")).is_err());
}

#[test]
fn detect_in_finds_jars() {
  let tmp = Temp::new("detect");
  let versions = tmp.0.join("versions");
  fs::create_dir_all(versions.join("1.20.1")).unwrap();
  fs::write(versions.join("1.20.1/1.20.1.jar"), b"x").unwrap();
  fs::create_dir_all(versions.join("no-jar")).unwrap();
  let installs = detect_in(&tmp.0);
  assert_eq!(installs.len(), 1);
  assert_eq!(installs[0].version, "1.20.1");
  assert!(installs[0].path.ends_with("1.20.1.jar"));
  assert!(installs[0].modified > 0);
  assert!(detect_in(&tmp.0.join("nowhere")).is_empty());
}

#[test]
fn skin_checks_extension_and_size() {
  let tmp = Temp::new("skin");
  let ok = tmp.0.join("Steve.PNG");
  fs::write(&ok, b"png").unwrap();
  assert!(check_skin(&ok).is_ok());
  let txt = tmp.0.join("skin.txt");
  fs::write(&txt, b"x").unwrap();
  assert!(check_skin(&txt).is_err());
  let big = tmp.0.join("big.png");
  fs::write(&big, vec![0u8; MAX_SKIN_BYTES as usize + 1]).unwrap();
  assert!(check_skin(&big).is_err());
  assert!(check_skin(&tmp.0.join("missing.png")).is_err());
  assert!(check_skin(&tmp.0).is_err());
}
