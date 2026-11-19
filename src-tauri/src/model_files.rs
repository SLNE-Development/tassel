//! Model files for the import flows (`src/bridge/javaModels.ts`): parent models and textures around a Java
//! model, Blockbench projects with textures that are not embedded, and folders of models to convert.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::files::{self, MAX_JAVA_MODEL_BYTES, MAX_JAVA_TEXTURE_BYTES};

/// Largest .bbmodel that is read (textures are usually embedded as base64).
pub const MAX_BBMODEL_BYTES: u64 = 128 * 1024 * 1024;
/// Most files a folder listing returns.
pub const MAX_LISTED_FILES: usize = 20_000;

fn safe_part(part: &str) -> bool {
  !part.is_empty() && part != "." && part != ".." && !part.contains(['\\', ':'])
}

/// Splits `namespace:path` (namespace minecraft when absent); None for ids that try to leave their folder.
fn split_location(location: &str) -> Option<(&str, &str)> {
  let (namespace, path) = match location.split_once(':') {
    Some((ns, rest)) => (if ns.is_empty() { "minecraft" } else { ns }, rest),
    None => ("minecraft", location),
  };
  (safe_part(namespace) && path.split('/').all(safe_part)).then_some((namespace, path))
}

/// Where a parent model `namespace:path` of a model at `anchor` may be: in the resource pack the model is
/// part of (`.../assets/<namespace>/models/<path>.json`), else under the model's folder (`<path>.json`).
pub fn java_model_candidates(anchor: &Path, location: &str) -> Vec<PathBuf> {
  let Some((namespace, path)) = split_location(location) else {
    return Vec::new();
  };
  let path = path.strip_suffix(".json").unwrap_or(path);
  let file = format!("{path}.json");
  let mut candidates = Vec::new();
  if let Some(assets) = anchor.ancestors().find(|dir| dir.file_name().is_some_and(|n| n.eq_ignore_ascii_case("assets"))) {
    candidates.push(assets.join(namespace).join("models").join(&file));
  } else if let Some(dir) = anchor.parent() {
    candidates.push(dir.join(&file));
  }
  candidates
}

async fn read_png(path: &Path) -> Option<Value> {
  if !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("png")) {
    return None;
  }
  let bytes = files::read_bytes_capped(&path.to_string_lossy(), MAX_JAVA_TEXTURE_BYTES, "open").await.ok()?;
  match files::image_info(&bytes) {
    Some(("image/png", width, height)) => Some(json!({ "data": files::encode_base64(&bytes), "width": width, "height": height })),
    _ => None,
  }
}

/// A parent model (`kind` "model": its JSON text) or texture (`kind` "texture": `{ data, width, height }`) of
/// the model at `anchor`, looked up in its resource pack; null when not found.
pub async fn read_java_asset(anchor: &str, kind: &str, location: &str) -> Result<Value, String> {
  let anchor = Path::new(anchor);
  match kind {
    "model" => {
      for candidate in java_model_candidates(anchor, location) {
        let Ok(bytes) = files::read_bytes_capped(&candidate.to_string_lossy(), MAX_JAVA_MODEL_BYTES, "open").await else {
          continue;
        };
        if let Ok(text) = files::decode_text(&bytes) {
          return Ok(Value::String(text));
        }
      }
      Ok(Value::Null)
    }
    "texture" => {
      for candidate in files::java_texture_candidates(anchor, location) {
        if let Some(image) = read_png(&candidate).await {
          return Ok(image);
        }
      }
      Ok(Value::Null)
    }
    other => Err(format!("Unknown asset kind \"{other}\" (model or texture)")),
  }
}

/// Reads a Blockbench project and the PNGs of its textures that are not embedded, found through the texture's
/// `relative_path` (next to the project) or `path`. Returns `{ text, images: { "<index>": { data, width, height } } }`.
pub async fn read_bbmodel(path: &str) -> Result<Value, String> {
  let bytes = files::read_bytes_capped(path, MAX_BBMODEL_BYTES, "open").await?;
  let text = files::decode_text(&bytes).map_err(|e| format!("\"{path}\" cannot be read: {e}"))?;
  let mut images = serde_json::Map::new();
  if let Ok(project) = serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}'))
    && let Some(textures) = project.get("textures").and_then(Value::as_array)
  {
    let dir = Path::new(path).parent().map(Path::to_path_buf).unwrap_or_default();
    for (index, texture) in textures.iter().enumerate() {
      let embedded = texture.get("source").and_then(Value::as_str).is_some_and(|s| s.starts_with("data:"));
      if embedded {
        continue;
      }
      let mut candidates = Vec::new();
      if let Some(rel) = texture.get("relative_path").and_then(Value::as_str).filter(|r| !r.is_empty()) {
        candidates.push(dir.join(rel));
      }
      if let Some(abs) = texture.get("path").and_then(Value::as_str).filter(|p| Path::new(p).is_absolute()) {
        candidates.push(PathBuf::from(abs));
      }
      for candidate in candidates {
        if let Some(image) = read_png(&candidate).await {
          images.insert(index.to_string(), image);
          break;
        }
      }
    }
  }
  Ok(json!({ "text": text, "images": images }))
}

/// Absolute paths of the .json and .bbmodel files in `folder` (and below, when `recursive`), sorted. Hidden
/// folders (`.git`) and `node_modules` are left out.
pub fn list_model_files(folder: &str, recursive: bool) -> Result<Vec<String>, String> {
  let root = Path::new(folder);
  if !root.is_dir() {
    return Err(format!("\"{folder}\" is not a folder"));
  }
  let mut out = Vec::new();
  let mut pending = vec![root.to_path_buf()];
  while let Some(dir) = pending.pop() {
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("Could not list \"{}\": {e}", dir.display()))?;
    for entry in entries.flatten() {
      let path = entry.path();
      let name = entry.file_name().to_string_lossy().to_string();
      let Ok(kind) = entry.file_type() else { continue };
      if kind.is_dir() {
        if recursive && !name.starts_with('.') && name != "node_modules" {
          pending.push(path);
        }
      } else if kind.is_file() && matches!(files::extension(&name).as_str(), "json" | "bbmodel") {
        out.push(path.to_string_lossy().to_string());
        if out.len() > MAX_LISTED_FILES {
          return Err(format!("\"{folder}\" has more than {MAX_LISTED_FILES} model files"));
        }
      }
    }
  }
  out.sort();
  Ok(out)
}

/// Writes a converted model (.tessel or .json); an existing file is only replaced with `overwrite`.
pub async fn write_model_file(path: &str, contents: &str, overwrite: bool) -> Result<(), String> {
  if !matches!(files::extension(path).as_str(), "tessel" | "json") {
    return Err(format!("\"{path}\" must end in .tessel or .json"));
  }
  if !Path::new(path).is_absolute() {
    return Err(format!("\"{path}\" is not an absolute path"));
  }
  if !overwrite && tokio::fs::try_exists(path).await.unwrap_or(false) {
    return Err(format!("\"{path}\" already exists"));
  }
  files::write_bytes(path, contents.as_bytes()).await
}

#[tauri::command]
pub async fn read_java_asset_file(anchor: String, kind: String, location: String) -> Result<Value, String> {
  read_java_asset(&anchor, &kind, &location).await
}

#[tauri::command]
pub async fn read_bbmodel_file(path: String) -> Result<Value, String> {
  if files::extension(&path) != "bbmodel" {
    return Err(format!("\"{path}\" must end in .bbmodel"));
  }
  read_bbmodel(&path).await
}

#[tauri::command]
pub async fn list_model_files_in(folder: String, recursive: bool) -> Result<Vec<String>, String> {
  tokio::task::spawn_blocking(move || list_model_files(&folder, recursive))
    .await
    .map_err(|e| format!("Listing failed: {e}"))?
}

#[tauri::command]
pub async fn write_converted_model(path: String, contents: String, overwrite: bool) -> Result<(), String> {
  write_model_file(&path, &contents, overwrite).await
}

#[cfg(test)]
mod tests {
  use super::*;

  fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tessel-model-files-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  fn png(width: u8, height: u8) -> Vec<u8> {
    let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
    png.extend([0, 0, 0, width, 0, 0, 0, height, 8, 6, 0, 0, 0]);
    png
  }

  #[test]
  fn parent_models_are_looked_up_in_the_resource_pack() {
    let model = Path::new("/packs/p/assets/mymod/models/item/gear.json");
    assert_eq!(java_model_candidates(model, "mymod:item/base"), [Path::new("/packs/p/assets/mymod/models/item/base.json")]);
    assert_eq!(java_model_candidates(model, "block/cube_all"), [Path::new("/packs/p/assets/minecraft/models/block/cube_all.json")]);
    assert_eq!(java_model_candidates(Path::new("/loose/gear.json"), "item/base"), [Path::new("/loose/item/base.json")]);
    assert!(java_model_candidates(model, "../../secret").is_empty());
    assert!(java_model_candidates(model, "mymod:item/../../x").is_empty());
    assert!(java_model_candidates(model, "x:C:\\y").is_empty());
  }

  #[test]
  fn assets_bbmodels_folders_and_writes() {
    let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
    runtime.block_on(async {
      let dir = temp_dir("all");
      let models = dir.join("assets").join("mymod").join("models").join("item");
      let textures = dir.join("assets").join("mymod").join("textures").join("item");
      std::fs::create_dir_all(&models).unwrap();
      std::fs::create_dir_all(&textures).unwrap();
      std::fs::write(models.join("base.json"), r#"{"parent":"item/generated"}"#).unwrap();
      std::fs::write(textures.join("gear.png"), png(16, 16)).unwrap();
      let anchor = models.join("gear.json").to_string_lossy().to_string();
      assert_eq!(read_java_asset(&anchor, "model", "mymod:item/base").await.unwrap(), json!(r#"{"parent":"item/generated"}"#));
      assert_eq!(read_java_asset(&anchor, "model", "mymod:item/none").await.unwrap(), Value::Null);
      assert_eq!(read_java_asset(&anchor, "texture", "mymod:item/gear").await.unwrap()["width"], 16);
      assert!(read_java_asset(&anchor, "sound", "x").await.is_err());

      std::fs::write(dir.join("tex.png"), png(32, 16)).unwrap();
      let bb = dir.join("thing.bbmodel");
      std::fs::write(&bb, r#"{"textures":[{"source":"data:image/png;base64,AAAA"},{"relative_path":"tex.png"},{"path":"/nowhere/x.png"}]}"#).unwrap();
      let read = read_bbmodel(&bb.to_string_lossy()).await.unwrap();
      assert_eq!(read["images"]["1"]["width"], 32);
      assert!(read["images"].get("0").is_none() && read["images"].get("2").is_none());

      let listed = list_model_files(&dir.to_string_lossy(), true).unwrap();
      assert_eq!(listed.len(), 2);
      assert!(listed.iter().any(|p| p.ends_with("thing.bbmodel")));
      assert_eq!(list_model_files(&dir.to_string_lossy(), false).unwrap().len(), 1);

      let out = dir.join("out").join("thing.tessel").to_string_lossy().to_string();
      write_model_file(&out, "{}", false).await.unwrap();
      assert!(write_model_file(&out, "{}", false).await.unwrap_err().contains("already exists"));
      write_model_file(&out, "{ }", true).await.unwrap();
      assert!(write_model_file(&dir.join("x.exe").to_string_lossy(), "", true).await.is_err());
      std::fs::remove_dir_all(&dir).unwrap();
    });
  }
}
