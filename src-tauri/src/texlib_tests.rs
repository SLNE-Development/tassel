use super::*;
use crate::testing::TempDir;

fn png(width: u32, height: u32) -> Vec<u8> {
  let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
  bytes.extend_from_slice(b"IHDR");
  bytes.extend_from_slice(&width.to_be_bytes());
  bytes.extend_from_slice(&height.to_be_bytes());
  bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
  bytes
}

fn write(root: &Path, relative: &str, bytes: &[u8]) {
  let path = root.join(relative);
  std::fs::create_dir_all(path.parent().unwrap()).unwrap();
  std::fs::write(path, bytes).unwrap();
}

#[test]
fn png_size_reads_the_header() {
  assert_eq!(png_size(&png(16, 32)), Some((16, 32)));
  assert_eq!(png_size(b"not a png at all, not at all"), None);
  assert_eq!(png_size(&png(16, 16)[..20]), None);
}

#[test]
fn texture_locations_come_from_the_file_path() {
  assert_eq!(texture_location("assets", "assets/surf/textures/block/stone.png"), Some(("surf".into(), "block/stone".into())));
  assert_eq!(texture_location("", "surf/textures/item/a/b.png"), Some(("surf".into(), "item/a/b".into())));
  assert_eq!(texture_location("assets", "assets/surf/models/block/stone.png"), None);
  assert_eq!(texture_location("assets", "assets/surf/textures/block/stone.png.mcmeta"), None);
  assert_eq!(texture_location("assets", "other/surf/textures/x.png"), None);
}

#[test]
fn scan_finds_textures_sizes_and_animations() {
  let dir = TempDir::new("texlib-scan");
  write(&dir.0, "assets/surf/textures/block/stone.png", &png(16, 16));
  write(&dir.0, "assets/surf/textures/block/water.png", &png(16, 64));
  write(&dir.0, "assets/surf/textures/block/water.png.mcmeta", br#"{"animation":{"frametime":2}}"#);
  write(&dir.0, "assets/minecraft/textures/item/stick.png", &png(16, 16));
  write(&dir.0, "assets/surf/models/block/stone.json", b"{}");
  write(&dir.0, "readme.png", &png(1, 1));
  let scan = scan(&dir.0).unwrap();
  assert_eq!(scan.assets, "assets");
  assert!(!scan.truncated);
  let names: Vec<_> = scan.textures.iter().map(|t| format!("{}:{}", t.namespace, t.path)).collect();
  assert_eq!(names, ["minecraft:item/stick", "surf:block/stone", "surf:block/water"]);
  let water = &scan.textures[2];
  assert_eq!((water.width, water.height), (16, 64));
  assert_eq!(water.mcmeta.as_deref(), Some(r#"{"animation":{"frametime":2}}"#));
  assert!(scan.textures[1].mcmeta.is_none());
}

#[test]
fn a_root_without_assets_is_an_assets_folder() {
  let dir = TempDir::new("texlib-assets-root");
  write(&dir.0, "surf/textures/block/stone.png", &png(16, 16));
  let scan = scan(&dir.0).unwrap();
  assert_eq!(scan.assets, "");
  assert_eq!(scan.textures[0].file, "surf/textures/block/stone.png");
  assert_eq!(scan.textures[0].path, "block/stone");
}

#[test]
fn only_textures_may_be_written_or_moved() {
  assert!(require_texture_file("assets/surf/textures/block/a.png").is_ok());
  assert!(require_texture_file("assets/surf/textures/block/a.png.mcmeta").is_ok());
  assert!(require_texture_file("assets/surf/models/block/a.json").is_err());
  assert!(require_texture_file("assets/surf/models/block/a.png").is_err());
  assert!(require_texture_file("../textures/a.png").is_err());
}

#[test]
fn moving_takes_the_mcmeta_along_and_never_overwrites() {
  let dir = TempDir::new("texlib-move");
  write(&dir.0, "assets/surf/textures/block/water.png", &png(16, 64));
  write(&dir.0, "assets/surf/textures/block/water.png.mcmeta", b"{}");
  write(&dir.0, "assets/surf/textures/block/stone.png", &png(16, 16));
  move_texture(&dir.0, "assets/surf/textures/block/water.png", "assets/surf/textures/fluid/water_still.png").unwrap();
  assert!(dir.0.join("assets/surf/textures/fluid/water_still.png").is_file());
  assert!(dir.0.join("assets/surf/textures/fluid/water_still.png.mcmeta").is_file());
  assert!(!dir.0.join("assets/surf/textures/block/water.png").exists());
  assert!(move_texture(&dir.0, "assets/surf/textures/block/stone.png", "assets/surf/textures/fluid/water_still.png").is_err());
}

#[test]
fn stat_reports_missing_files() {
  let dir = TempDir::new("texlib-stat");
  write(&dir.0, "assets/surf/textures/a.png", &png(1, 1));
  let times = stat(&dir.0, &["assets/surf/textures/a.png".into(), "assets/surf/textures/b.png".into(), "../x.png".into()]);
  assert!(times[0].is_some());
  assert_eq!(times[1], None);
  assert_eq!(times[2], None);
}

#[test]
fn library_folders_are_remembered() {
  let config = TempDir::new("texlib-config");
  let folder = TempDir::new("texlib-folder");
  let libraries = Libraries::load(&config.0);
  let added = libraries.folders.add(&folder.0.to_string_lossy(), Some("Shared"), None).unwrap();
  let again = Libraries::load(&config.0);
  assert_eq!(again.folders.list()[0].id, added.id);
  assert_eq!(folder_info(added).source, format!("folder:{}", again.folders.list()[0].id));
}
