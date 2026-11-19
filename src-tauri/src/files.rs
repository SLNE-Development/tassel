//! File access for the UI's own open/save/import/export flows (`src/bridge/files.ts`) and the native MCP tools.

use std::path::Path;

use base64::Engine;

pub async fn read_text(path: &str) -> Result<String, String> {
  tokio::fs::read_to_string(path)
    .await
    .map_err(|e| format!("Could not read \"{path}\": {e}"))
}

/// Writes a file, creating parent directories as needed.
pub async fn write_bytes(path: &str, bytes: &[u8]) -> Result<(), String> {
  if let Some(parent) = Path::new(path).parent()
    && !parent.as_os_str().is_empty()
  {
    tokio::fs::create_dir_all(parent)
      .await
      .map_err(|e| format!("Could not create folder \"{}\": {e}", parent.display()))?;
  }
  tokio::fs::write(path, bytes)
    .await
    .map_err(|e| format!("Could not write \"{path}\": {e}"))
}

pub fn decode_base64(data: &str) -> Result<Vec<u8>, String> {
  base64::engine::general_purpose::STANDARD
    .decode(data.trim())
    .map_err(|e| format!("Invalid base64 data: {e}"))
}

pub fn encode_base64(bytes: &[u8]) -> String {
  base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Lower-case file extension without the dot, or an empty string.
pub fn extension(path: &str) -> String {
  Path::new(path)
    .extension()
    .map(|e| e.to_string_lossy().to_ascii_lowercase())
    .unwrap_or_default()
}

/// 3D formats `import.file` reads, by extension.
pub const IMPORT_EXTENSIONS: [&str; 6] = ["glb", "gltf", "obj", "stl", "ply", "fbx"];
/// 3D formats `export.file` writes, by extension.
/// `json` is a Minecraft Java block/item model (Minecraft documents only).
pub const EXPORT_EXTENSIONS: [&str; 7] = ["glb", "gltf", "obj", "stl", "ply", "usdz", "json"];
/// Images that can become textures.
pub const IMAGE_EXTENSIONS: [&str; 4] = ["png", "jpg", "jpeg", "webp"];
/// Containers `render.video` writes.
pub const VIDEO_EXTENSIONS: [&str; 2] = ["mp4", "webm"];
/// Largest file that is read for import: 192 MB, which is 256 MB as base64 (the limit of `import.file`).
pub const MAX_IMPORT_BYTES: u64 = 192 * 1024 * 1024;

/// Reads a file for import, refusing files above the import limit before loading them.
pub async fn read_bytes_limited(path: &str) -> Result<Vec<u8>, String> {
  read_bytes_capped(path, MAX_IMPORT_BYTES, "import").await
}

/// Reads a file of at most `max` bytes; the size is checked before anything is loaded.
pub async fn read_bytes_capped(path: &str, max: u64, purpose: &str) -> Result<Vec<u8>, String> {
  let meta = tokio::fs::metadata(path)
    .await
    .map_err(|e| format!("Could not read \"{path}\": {e}"))?;
  if !meta.is_file() {
    return Err(format!("\"{path}\" is not a file"));
  }
  if meta.len() > max {
    const MB: f64 = 1024.0 * 1024.0;
    return Err(format!(
      "\"{path}\" is too large to {purpose}: {:.1} MB, the limit is {} MB.",
      meta.len() as f64 / MB,
      max / (1024 * 1024)
    ));
  }
  tokio::fs::read(path)
    .await
    .map_err(|e| format!("Could not read \"{path}\": {e}"))
}

/// Text of a file an AI client or a script wrote: UTF-8 with or without a byte order mark, or
/// UTF-16 with one (what Windows PowerShell 5 writes by default).
pub fn decode_text(bytes: &[u8]) -> Result<String, String> {
  let utf16 = |bytes: &[u8], unit: fn([u8; 2]) -> u16| {
    let (pairs, rest) = bytes.as_chunks::<2>();
    if !rest.is_empty() {
      return Err("it is not valid UTF-16 text".to_string());
    }
    let units: Vec<u16> = pairs.iter().map(|pair| unit(*pair)).collect();
    String::from_utf16(&units).map_err(|_| "it is not valid UTF-16 text".to_string())
  };
  match bytes {
    [0xef, 0xbb, 0xbf, rest @ ..] => std::str::from_utf8(rest).map(str::to_string).map_err(|_| "it is not valid UTF-8 text".into()),
    [0xff, 0xfe, rest @ ..] => utf16(rest, u16::from_le_bytes),
    [0xfe, 0xff, rest @ ..] => utf16(rest, u16::from_be_bytes),
    _ => std::str::from_utf8(bytes).map(str::to_string).map_err(|_| "it is not valid UTF-8 text".into()),
  }
}

/// A file name that came from the document (or from the webview) as a plain name inside one folder:
/// no path separators or drive letters, no characters Windows forbids, no leading or trailing dots.
/// None if nothing usable is left.
pub fn safe_file_name(name: &str) -> Option<String> {
  const FORBIDDEN: &str = "<>:\"/\\|?*";
  let cleaned: String = name
    .chars()
    .map(|c| if c.is_control() || c.is_whitespace() || FORBIDDEN.contains(c) { '_' } else { c })
    .collect();
  let cleaned = cleaned.trim_matches(|c| c == '.' || c == '_');
  let stem = cleaned.split('.').next().unwrap_or_default().to_ascii_lowercase();
  let reserved = matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
    || (stem.len() == 4
      && (stem.starts_with("com") || stem.starts_with("lpt"))
      && stem.ends_with(|c: char| c.is_ascii_digit()));
  if cleaned.is_empty() || reserved { None } else { Some(cleaned.to_string()) }
}

/// One side file of an OBJ export (a texture image).
#[derive(Debug, Clone, serde::Deserialize)]
pub struct SideFile {
  pub name: String,
  pub base64: String,
}

/// Writes an OBJ export: the .obj at `path`, and next to it the material library and the texture
/// images. Side file names are sanitised and must be an .mtl or an image, so nothing can be written
/// outside the folder of the .obj or over other kinds of files. Returns the names written, .obj first.
pub async fn write_obj_bundle(
  path: &str,
  text: &str,
  mtl_name: &str,
  mtl: &str,
  images: &[SideFile],
) -> Result<Vec<String>, String> {
  let folder = Path::new(path).parent().unwrap_or(Path::new(""));
  let obj_name = Path::new(path)
    .file_name()
    .map(|n| n.to_string_lossy().into_owned())
    .unwrap_or_default();

  let side_path = |name: &str, allowed: &[&str]| -> Result<(String, String), String> {
    let safe = safe_file_name(name).ok_or_else(|| format!("\"{name}\" is not a usable file name"))?;
    if !allowed.contains(&extension(&safe).as_str()) {
      return Err(format!("The side file \"{name}\" must end in .{}", allowed.join(" or .")));
    }
    Ok((folder.join(&safe).to_string_lossy().into_owned(), safe))
  };

  // Validate everything before the first write.
  let (mtl_path, mtl_file) = side_path(mtl_name, &["mtl"])?;
  let mut decoded = Vec::with_capacity(images.len());
  for image in images {
    let (image_path, image_file) = side_path(&image.name, &IMAGE_EXTENSIONS)?;
    decoded.push((image_path, image_file, decode_base64(&image.base64)?));
  }

  write_bytes(path, text.as_bytes()).await?;
  write_bytes(&mtl_path, mtl.as_bytes()).await?;
  let mut written = vec![obj_name, mtl_file];
  for (image_path, image_file, bytes) in decoded {
    write_bytes(&image_path, &bytes).await?;
    written.push(image_file);
  }
  Ok(written)
}

/// MIME type and pixel size of a PNG, JPEG or WebP file, read from its header.
pub fn image_info(b: &[u8]) -> Option<(&'static str, u32, u32)> {
  let be16 = |i: usize| b.get(i..i + 2).map(|s| u32::from(u16::from_be_bytes([s[0], s[1]])));
  let be32 = |i: usize| b.get(i..i + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]));
  let le16 = |i: usize| b.get(i..i + 2).map(|s| u32::from(u16::from_le_bytes([s[0], s[1]])));
  let le24 = |i: usize| b.get(i..i + 3).map(|s| u32::from(s[0]) | u32::from(s[1]) << 8 | u32::from(s[2]) << 16);

  if b.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
    return Some(("image/png", be32(16)?, be32(20)?));
  }
  if b.starts_with(&[0xff, 0xd8, 0xff]) {
    let mut i = 2;
    while i + 4 <= b.len() {
      if b[i] != 0xff {
        return None;
      }
      let marker = b[i + 1];
      match marker {
        0xff => i += 1,
        // SOF0..SOF15 except DHT, JPG and DAC carry the frame size.
        0xc0..=0xcf if !matches!(marker, 0xc4 | 0xc8 | 0xcc) => return Some(("image/jpeg", be16(i + 7)?, be16(i + 5)?)),
        // Markers without a length field.
        0x01 | 0xd0..=0xd8 => i += 2,
        _ => i += 2 + be16(i + 2)? as usize,
      }
    }
    return None;
  }
  if b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WEBP".as_slice()) {
    return match b.get(12..16)? {
      b"VP8X" => Some(("image/webp", le24(24)? + 1, le24(27)? + 1)),
      b"VP8 " => Some(("image/webp", le16(26)? & 0x3fff, le16(28)? & 0x3fff)),
      b"VP8L" => {
        let bits = b.get(21..25).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))?;
        Some(("image/webp", (bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
      }
      _ => None,
    };
  }
  None
}

/// The webview may only touch the file types the editor works with, whatever path it is handed
/// (a document's file path can be set through MCP).
fn require_extension(path: &str, allowed: &[&str]) -> Result<(), String> {
  if allowed.contains(&extension(path).as_str()) {
    Ok(())
  } else {
    Err(format!("\"{path}\" must end in .{}", allowed.join(" or .")))
  }
}

/// Largest Minecraft model file that is read (models are small text files).
pub const MAX_JAVA_MODEL_BYTES: u64 = 16 * 1024 * 1024;
/// Largest texture image of a Minecraft model that is read.
pub const MAX_JAVA_TEXTURE_BYTES: u64 = 16 * 1024 * 1024;

/// Where the image of a texture location (`namespace:folder/name`) of a model at `model_path` may be:
/// in the resource pack the model is part of (`.../assets/<namespace>/textures/<folder>/<name>.png`),
/// else next to the model (`<name>.png`, then `<folder>/<name>.png`). Locations that try to leave
/// those folders (`..`, absolute paths, drive letters) have no candidates.
pub fn java_texture_candidates(model_path: &Path, location: &str) -> Vec<std::path::PathBuf> {
  let (namespace, texture_path) = match location.split_once(':') {
    Some((ns, rest)) => (if ns.is_empty() { "minecraft" } else { ns }, rest),
    None => ("minecraft", location),
  };
  let safe = |part: &str| !part.is_empty() && part != "." && part != ".." && !part.contains(['\\', ':']);
  if !safe(namespace) || !texture_path.split('/').all(safe) {
    return Vec::new();
  }
  let file = format!("{texture_path}.png");
  let mut candidates = Vec::new();
  if let Some(assets) = model_path.ancestors().find(|dir| dir.file_name().is_some_and(|n| n.eq_ignore_ascii_case("assets"))) {
    candidates.push(assets.join(namespace).join("textures").join(&file));
  }
  if let Some(dir) = model_path.parent() {
    let name = texture_path.rsplit('/').next().unwrap_or(texture_path);
    candidates.push(dir.join(format!("{name}.png")));
    if texture_path.contains('/') {
      candidates.push(dir.join(&file));
    }
  }
  candidates
}

/// Reads a Minecraft Java model and the PNG images of its textures that can be found (see
/// `java_texture_candidates`). Returns `{ json, images: { location: { data, width, height } }, missing }`.
pub async fn read_java_model(path: &str) -> Result<serde_json::Value, String> {
  let bytes = read_bytes_capped(path, MAX_JAVA_MODEL_BYTES, "open").await?;
  let json = decode_text(&bytes).map_err(|e| format!("\"{path}\" cannot be read: {e}"))?;
  let model: serde_json::Value =
    serde_json::from_str(json.trim_start_matches('\u{feff}')).map_err(|e| format!("\"{path}\" is not valid JSON: {e}"))?;
  let mut images = serde_json::Map::new();
  let mut missing: Vec<String> = Vec::new();
  if let Some(textures) = model.get("textures").and_then(serde_json::Value::as_object) {
    for location in textures.values().filter_map(serde_json::Value::as_str) {
      if location.starts_with('#') || images.contains_key(location) || missing.iter().any(|m| m == location) {
        continue;
      }
      let mut found = None;
      for candidate in java_texture_candidates(Path::new(path), location) {
        let Ok(bytes) = read_bytes_capped(&candidate.to_string_lossy(), MAX_JAVA_TEXTURE_BYTES, "open").await else {
          continue;
        };
        if let Some(("image/png", width, height)) = image_info(&bytes) {
          found = Some(serde_json::json!({ "data": encode_base64(&bytes), "width": width, "height": height }));
          break;
        }
      }
      match found {
        Some(image) => {
          images.insert(location.to_string(), image);
        }
        None => missing.push(location.to_string()),
      }
    }
  }
  Ok(serde_json::json!({ "json": json, "images": images, "missing": missing }))
}

/// Reads a Minecraft Java model (.json) with the texture images found in its resource pack.
#[tauri::command]
pub async fn read_java_model_file(path: String) -> Result<serde_json::Value, String> {
  require_extension(&path, &["json"])?;
  read_java_model(&path).await
}

#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
  require_extension(&path, &["tessel"])?;
  read_text(&path).await
}

/// Reads a 3D file for the UI's import flow and returns it as base64.
#[tauri::command]
pub async fn read_binary_file(path: String) -> Result<String, String> {
  require_extension(&path, &IMPORT_EXTENSIONS)?;
  Ok(encode_base64(&read_bytes_limited(&path).await?))
}

#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> Result<(), String> {
  require_extension(&path, &["tessel", "gltf", "json"])?;
  write_bytes(&path, contents.as_bytes()).await
}

#[tauri::command]
pub async fn write_binary_file(path: String, base64: String) -> Result<(), String> {
  // 3D exports, rendered images and exported videos (the save dialogs of `src/bridge/files.ts`).
  require_extension(&path, &["glb", "stl", "ply", "usdz", "png", "jpg", "jpeg", "webp", "mp4", "webm"])?;
  write_bytes(&path, &decode_base64(&base64)?).await
}

/// Writes an OBJ export with its material library and texture images next to it.
#[tauri::command]
pub async fn write_obj_export(
  path: String,
  text: String,
  mtl_name: String,
  mtl: String,
  files: Vec<SideFile>,
) -> Result<Vec<String>, String> {
  require_extension(&path, &["obj"])?;
  write_obj_bundle(&path, &text, &mtl_name, &mtl, &files).await
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn file_names_from_the_document_are_made_safe() {
    assert_eq!(safe_file_name("scene_wood.png").as_deref(), Some("scene_wood.png"));
    assert_eq!(safe_file_name("..\\..\\Windows\\evil.png").as_deref(), Some("Windows_evil.png"));
    assert_eq!(safe_file_name("../../etc/passwd").as_deref(), Some("etc_passwd"));
    assert_eq!(safe_file_name("C:\\boot.mtl").as_deref(), Some("C__boot.mtl"));
    assert_eq!(safe_file_name("a b\tc.mtl").as_deref(), Some("a_b_c.mtl"));
    assert_eq!(safe_file_name("Größe.png").as_deref(), Some("Größe.png"));
    assert_eq!(safe_file_name(".."), None);
    assert_eq!(safe_file_name(""), None);
    assert_eq!(safe_file_name("con.png"), None);
    assert_eq!(safe_file_name("LPT1.mtl"), None);
    assert_eq!(safe_file_name("compost.png").as_deref(), Some("compost.png"));
  }

  #[test]
  fn extensions_are_checked_case_insensitively() {
    assert!(require_extension("C:\\a\\b.GLB", &IMPORT_EXTENSIONS).is_ok());
    assert!(require_extension("C:\\a\\b.exe", &IMPORT_EXTENSIONS).is_err());
    assert!(require_extension("C:\\a\\glb", &IMPORT_EXTENSIONS).is_err());
    assert!(require_extension("C:\\a\\b.usdz", &EXPORT_EXTENSIONS).is_ok());
  }

  #[test]
  fn java_textures_are_looked_up_in_the_resource_pack() {
    let model = Path::new("/packs/p/assets/mymod/models/block/gear.json");
    assert_eq!(
      java_texture_candidates(model, "mymod:block/gear"),
      [
        Path::new("/packs/p/assets/mymod/textures/block/gear.png").to_path_buf(),
        Path::new("/packs/p/assets/mymod/models/block/gear.png").to_path_buf(),
        Path::new("/packs/p/assets/mymod/models/block/block/gear.png").to_path_buf(),
      ]
    );
    assert_eq!(java_texture_candidates(model, "block/stone")[0], Path::new("/packs/p/assets/minecraft/textures/block/stone.png"));
    let loose = Path::new("/models/gear.json");
    assert_eq!(java_texture_candidates(loose, "item/gear"), [Path::new("/models/gear.png"), Path::new("/models/item/gear.png")]);
    assert!(java_texture_candidates(model, "../../secret").is_empty());
    assert!(java_texture_candidates(model, "mymod:block/../../x").is_empty());
    assert!(java_texture_candidates(model, "..:block/x").is_empty());
    assert!(java_texture_candidates(model, "block/C:\\x").is_empty());
  }

  #[test]
  fn java_models_are_read_with_their_textures() {
    let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
    runtime.block_on(async {
      let dir = std::env::temp_dir().join(format!("tessel-java-{}", std::process::id()));
      let models = dir.join("assets").join("minecraft").join("models").join("block");
      let textures = dir.join("assets").join("minecraft").join("textures").join("block");
      std::fs::create_dir_all(&models).unwrap();
      std::fs::create_dir_all(&textures).unwrap();
      let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
      png.extend([0, 0, 0, 16, 0, 0, 0, 32, 8, 6, 0, 0, 0]);
      std::fs::write(textures.join("stone.png"), &png).unwrap();
      let model = models.join("thing.json");
      std::fs::write(&model, r##"{"textures": {"0": "block/stone", "1": "block/nope", "particle": "#0"}}"##).unwrap();
      let read = read_java_model(&model.to_string_lossy()).await.unwrap();
      assert_eq!(read["images"]["block/stone"]["width"], 16);
      assert_eq!(read["images"]["block/stone"]["height"], 32);
      assert_eq!(read["missing"], serde_json::json!(["block/nope"]));
      assert!(read["json"].as_str().unwrap().contains("block/nope"));
      std::fs::remove_dir_all(&dir).unwrap();
    });
  }

  #[test]
  fn image_sizes_come_from_the_headers() {
    let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
    png.extend([0, 0, 1, 0, 0, 0, 0, 64, 8, 2, 0, 0, 0]);
    assert_eq!(image_info(&png), Some(("image/png", 256, 64)));
    let jpeg = [0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 3, 0, 5, 3, 0, 0, 0];
    assert_eq!(image_info(&jpeg), Some(("image/jpeg", 5, 3)));
    let mut webp = b"RIFF\0\0\0\0WEBPVP8X\x0a\0\0\0\0\0\0\0".to_vec();
    webp.extend([9, 0, 0, 4, 0, 0]);
    assert_eq!(image_info(&webp), Some(("image/webp", 10, 5)));
    assert_eq!(image_info(b"GIF89a"), None);
    assert_eq!(image_info(&png[..12]), None);
  }

  #[test]
  fn obj_side_files_stay_in_the_folder() {
    let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
    runtime.block_on(async {
      let dir = std::env::temp_dir().join(format!("tessel-test-{}", std::process::id()));
      let obj = dir.join("out").join("model.obj").to_string_lossy().into_owned();
      let image = |name: &str| SideFile { name: name.into(), base64: "AQID".into() };

      let written = write_obj_bundle(&obj, "o a\n", "model.mtl", "newmtl a\n", &[image("..\\..\\escape.png")])
        .await
        .unwrap();
      assert_eq!(written, ["model.obj", "model.mtl", "escape.png"]);
      assert_eq!(std::fs::read(dir.join("out").join("escape.png")).unwrap(), [1, 2, 3]);
      assert!(!dir.join("escape.png").exists());

      // Wrong kinds of side files are refused before anything is written.
      let other = dir.join("other").join("model.obj").to_string_lossy().into_owned();
      assert!(write_obj_bundle(&other, "", "model.mtl", "", &[image("run.exe")]).await.is_err());
      assert!(write_obj_bundle(&other, "", "model.txt", "", &[]).await.is_err());
      assert!(write_obj_bundle(&other, "", "model.obj", "", &[]).await.is_err());
      assert!(write_obj_bundle(&other, "", "..", "", &[]).await.is_err());
      let broken = SideFile { name: "a.png".into(), base64: "!".into() };
      assert!(write_obj_bundle(&other, "", "model.mtl", "", &[broken]).await.is_err());
      assert!(!dir.join("other").exists());
      std::fs::remove_dir_all(&dir).unwrap();
    });
  }
}
