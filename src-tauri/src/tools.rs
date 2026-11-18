//! Tool dispatch: frontend commands plus the native tools that touch the file system.

use std::path::Path;
use std::time::Duration;

use serde_json::{Map, Value, json};

use crate::bridge::Bridge;
use crate::files;

pub struct NativeTool {
  pub name: &'static str,
  pub description: &'static str,
  pub input_schema: Value,
}

/// What a tool call produced. `is_error` results still carry a useful value (e.g. a partial batch).
pub struct ToolOutput {
  pub value: Value,
  pub is_error: bool,
}

const EXPORT_FORMATS: &str = ".glb (binary glTF, one self-contained file), .gltf (glTF JSON, everything embedded), \
  .obj (Wavefront OBJ with .mtl and texture images next to it), .stl, .ply and .usdz";
const IMPORT_FORMATS: &str =
  ".glb, .gltf, .obj, .stl, .ply and .fbx (3D models), or .png, .jpg and .webp (an image as a texture)";
/// Parsing or writing a large file in the editor can take a while.
const FILE_TIMEOUT: Duration = Duration::from_secs(180);

pub fn native_tools() -> Vec<NativeTool> {
  vec![
    NativeTool {
      name: "file_save",
      description: "Save the active document as a Tessel project file (.tessel, JSON) on disk and mark it as saved. \
        Pass an absolute path ending in .tessel to save to a new location (\"save as\"); omit path to save to the \
        file the document was opened from or last saved to (see activeDocument.filePath in app_get_state). \
        Missing parent folders are created; an existing file is overwritten. The document is renamed to the file name.",
      input_schema: json!({
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Absolute path of the project file, ending in .tessel. Optional if the document already has a file path."
          }
        },
        "additionalProperties": false
      }),
    },
    NativeTool {
      name: "file_open",
      description: "Open a Tessel project file (.tessel) from disk in a new document tab and switch to it. \
        Returns the id and name of the new document. Other open documents are not affected.",
      input_schema: json!({
        "type": "object",
        "properties": {
          "path": { "type": "string", "description": "Absolute path of the project file, ending in .tessel." }
        },
        "required": ["path"],
        "additionalProperties": false
      }),
    },
    NativeTool {
      name: "file_export",
      description: "Export the active document to a 3D file on disk for use in other tools and game engines. \
        The file extension chooses the format: .glb (binary glTF 2.0, one self-contained file with materials, \
        textures, UVs and the group hierarchy - usually what you want), .gltf (the same as JSON text with everything \
        embedded as base64), .obj (Wavefront OBJ: polygons stay polygons; the material library <name>.mtl and the \
        texture images <name>_<texture>.png are written into the same folder), .stl (binary, triangles only, for 3D \
        printing), .ply (binary, triangles with normals and UVs) or .usdz (USD archive for AR viewers). Exported are \
        the visible objects as they look after their modifiers; .obj, .stl and .ply have no transforms, so they are \
        written in world space. Set selectionOnly to export just the selected objects. Missing parent folders are \
        created; existing files are overwritten. Returns the files written. This does not save the project - use \
        file_save for that.",
      input_schema: json!({
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Absolute path of the exported file, ending in .glb, .gltf, .obj, .stl, .ply or .usdz."
          },
          "selectionOnly": {
            "type": "boolean",
            "default": false,
            "description": "Export only the selected objects instead of the whole document."
          }
        },
        "required": ["path"],
        "additionalProperties": false
      }),
    },
    NativeTool {
      name: "file_import",
      description: "Import a file from disk into the active document. A 3D model (.glb, .gltf, .obj, .stl, .ply, .fbx) \
        adds its meshes as new objects, with materials, embedded textures and the node hierarchy (as groups) where \
        the format has them, as one undo step; the new objects are selected. Only the one file is read: an .obj \
        comes in without its .mtl (materials are created by name with default values), and a .gltf must be \
        self-contained (use .glb otherwise). Triangle formats arrive as triangle meshes; FBX files are converted \
        to Y up and meters. An image (.png, .jpg, .jpeg, .webp) is added as a texture; put it on a material with \
        material_update { id, maps: { baseColor: textureId } }. Files up to 192 MB. Returns the ids and names of \
        what was added, and warnings about anything that was skipped.",
      input_schema: json!({
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Absolute path of the file to import: .glb, .gltf, .obj, .stl, .ply, .fbx, or an image (.png, .jpg, .jpeg, .webp)."
          }
        },
        "required": ["path"],
        "additionalProperties": false
      }),
    },
    NativeTool {
      name: "batch",
      description: "Run several tool calls in order with a single request, e.g. to build a scene from many \
        primitives and finish with view_screenshot. Execution stops at the first failing call; calls before it \
        stay applied (each is its own undo step). Returns the result of every executed call in order. \
        Any tool except batch itself can be used.",
      input_schema: json!({
        "type": "object",
        "properties": {
          "commands": {
            "type": "array",
            "minItems": 1,
            "description": "The tool calls to run, in order.",
            "items": {
              "type": "object",
              "properties": {
                "tool": { "type": "string", "description": "Tool name, e.g. scene_add_primitive." },
                "params": { "type": "object", "description": "Arguments of that tool. Defaults to {}." }
              },
              "required": ["tool"],
              "additionalProperties": false
            }
          }
        },
        "required": ["commands"],
        "additionalProperties": false
      }),
    },
  ]
}

/// Runs any tool by its MCP name.
pub async fn call(bridge: &Bridge, tool: &str, args: Value) -> ToolOutput {
  if tool == "batch" {
    return batch(bridge, &args).await;
  }
  match call_single(bridge, tool, args).await {
    Ok(value) => ToolOutput { value, is_error: false },
    Err(message) => ToolOutput { value: Value::String(message), is_error: true },
  }
}

async fn call_single(bridge: &Bridge, tool: &str, args: Value) -> Result<Value, String> {
  match tool {
    "file_save" => file_save(bridge, &args).await,
    "file_open" => file_open(bridge, &args).await,
    "file_export" => file_export(bridge, &args).await,
    "file_import" => file_import(bridge, &args).await,
    "batch" => Err("batch cannot be nested inside batch".into()),
    _ => match bridge.find_command(tool) {
      Some(command) => bridge.call(&command.command_id(), args).await,
      None if bridge.commands().is_empty() => Err(format!(
        "Unknown tool \"{tool}\". The Tessel editor window has not registered its commands yet - try again in a moment."
      )),
      None => Err(format!("Unknown tool \"{tool}\". Use tools/list to see the available tools.")),
    },
  }
}

async fn batch(bridge: &Bridge, args: &Value) -> ToolOutput {
  let Some(commands) = args.get("commands").and_then(Value::as_array) else {
    return ToolOutput { value: Value::String("\"commands\" must be an array of { tool, params }".into()), is_error: true };
  };
  let total = commands.len();
  let mut results = Vec::with_capacity(total);
  let mut error = None;

  for (index, entry) in commands.iter().enumerate() {
    let tool = entry.get("tool").and_then(Value::as_str).unwrap_or_default();
    let outcome = if tool.is_empty() {
      Err("Each batch entry needs a \"tool\" name".to_string())
    } else {
      let params = entry.get("params").filter(|p| !p.is_null()).cloned().unwrap_or_else(|| json!({}));
      call_single(bridge, tool, params).await
    };
    match outcome {
      Ok(result) => results.push(json!({ "tool": tool, "result": result })),
      Err(message) => {
        error = Some(json!({ "index": index, "tool": tool, "message": message }));
        break;
      }
    }
  }

  let mut value = json!({ "completed": results.len(), "total": total, "results": results });
  let is_error = error.is_some();
  if let Some(error) = error {
    value["error"] = error;
  }
  ToolOutput { value, is_error }
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
  args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

fn require_absolute(path: &str) -> Result<(), String> {
  if Path::new(path).is_absolute() {
    Ok(())
  } else {
    let extension = Some(files::extension(path)).filter(|e| !e.is_empty()).unwrap_or_else(|| "tessel".into());
    Err(format!("\"{path}\" is not an absolute path. Pass a full path such as C:\\Models\\chair.{extension}."))
  }
}

fn require_tessel(path: &str) -> Result<(), String> {
  require_absolute(path)?;
  if files::extension(path) == "tessel" {
    Ok(())
  } else {
    Err(format!("\"{path}\" is not a Tessel project file: the path must end in .tessel"))
  }
}

fn file_stem(path: &str) -> String {
  Path::new(path)
    .file_stem()
    .map(|s| s.to_string_lossy().into_owned())
    .unwrap_or_default()
}

fn field<'a>(value: &'a Value, key: &str, command: &str) -> Result<&'a str, String> {
  value
    .get(key)
    .and_then(Value::as_str)
    .ok_or_else(|| format!("The editor returned no \"{key}\" from {command}"))
}

async fn file_save(bridge: &Bridge, args: &Value) -> Result<Value, String> {
  // Validate an explicit path before bothering the frontend.
  if let Some(path) = str_arg(args, "path") {
    require_tessel(path)?;
  }
  let doc = bridge.call("document.serialize", json!({})).await?;
  let path = match str_arg(args, "path").or_else(|| doc.get("filePath").and_then(Value::as_str)) {
    Some(path) => path.to_string(),
    None => return Err("This document has never been saved, so a path is required: pass an absolute path ending in .tessel.".into()),
  };
  require_tessel(&path)?;

  let json = field(&doc, "json", "document.serialize")?;
  files::write_bytes(&path, json.as_bytes()).await?;

  let name = file_stem(&path);
  let mut mark = Map::new();
  if let Some(id) = doc.get("id").filter(|id| id.is_string()) {
    mark.insert("id".into(), id.clone());
  }
  mark.insert("filePath".into(), json!(path));
  mark.insert("name".into(), json!(name));
  bridge.call("document.mark_saved", Value::Object(mark)).await?;

  Ok(json!({ "saved": true, "path": path, "name": name, "bytes": json.len() }))
}

async fn file_open(bridge: &Bridge, args: &Value) -> Result<Value, String> {
  let path = str_arg(args, "path").ok_or("\"path\" is required")?;
  require_tessel(path)?;
  let json = files::read_text(path).await?;
  let opened = bridge
    .call("document.load", json!({ "json": json, "filePath": path, "name": file_stem(path) }))
    .await?;
  let mut result = json!({ "opened": true, "path": path });
  if let (Some(result), Some(opened)) = (result.as_object_mut(), opened.as_object()) {
    for (key, value) in opened {
      result.insert(key.clone(), value.clone());
    }
  }
  Ok(result)
}

fn file_name(path: &str) -> String {
  Path::new(path)
    .file_name()
    .map(|s| s.to_string_lossy().into_owned())
    .unwrap_or_default()
}

async fn file_export(bridge: &Bridge, args: &Value) -> Result<Value, String> {
  let path = str_arg(args, "path").ok_or("\"path\" is required")?;
  require_absolute(path)?;
  let format = files::extension(path);
  if format.is_empty() {
    return Err(format!("\"{path}\" has no file extension. Supported export formats: {EXPORT_FORMATS}."));
  }
  if !files::EXPORT_EXTENSIONS.contains(&format.as_str()) {
    return Err(format!("Cannot export to .{format}. Supported export formats: {EXPORT_FORMATS}."));
  }
  let selection_only = args.get("selectionOnly").and_then(Value::as_bool).unwrap_or(false);

  let params = json!({ "format": format, "selectionOnly": selection_only, "name": file_stem(path) });
  let exported = bridge.call_with_timeout("export.file", params, FILE_TIMEOUT).await?;

  let mut written = vec![file_name(path)];
  let bytes = if format == "obj" {
    let text = field(&exported, "text", "export.file")?;
    let side_files: Vec<files::SideFile> = match exported.get("files") {
      Some(list) => serde_json::from_value(list.clone())
        .map_err(|e| format!("The editor returned invalid side files from export.file: {e}"))?,
      None => Vec::new(),
    };
    written = files::write_obj_bundle(
      path,
      text,
      field(&exported, "mtlName", "export.file")?,
      field(&exported, "mtl", "export.file")?,
      &side_files,
    )
    .await?;
    text.len()
  } else if let Some(text) = exported.get("text").and_then(Value::as_str) {
    files::write_bytes(path, text.as_bytes()).await?;
    text.len()
  } else {
    let bytes = files::decode_base64(field(&exported, "base64", "export.file")?)?;
    files::write_bytes(path, &bytes).await?;
    bytes.len()
  };

  Ok(json!({
    "exported": true,
    "path": path,
    "format": format,
    "bytes": bytes,
    "files": written,
    "selectionOnly": selection_only
  }))
}

async fn file_import(bridge: &Bridge, args: &Value) -> Result<Value, String> {
  let path = str_arg(args, "path").ok_or("\"path\" is required")?;
  require_absolute(path)?;
  let format = files::extension(path);
  let is_image = files::IMAGE_EXTENSIONS.contains(&format.as_str());
  if format.is_empty() {
    return Err(format!("\"{path}\" has no file extension. Supported import formats: {IMPORT_FORMATS}."));
  }
  if !is_image && !files::IMPORT_EXTENSIONS.contains(&format.as_str()) {
    let hint = if format == "tessel" { " Use file_open for .tessel project files." } else { "" };
    return Err(format!("Cannot import .{format} files. Supported import formats: {IMPORT_FORMATS}.{hint}"));
  }
  let bytes = files::read_bytes_limited(path).await?;
  if bytes.is_empty() {
    return Err(format!("\"{path}\" is empty"));
  }

  let imported = if is_image {
    let (mime_type, width, height) = files::image_info(&bytes)
      .ok_or_else(|| format!("\"{path}\" is not a PNG, JPEG or WebP image (its content does not match)"))?;
    let params = json!({
      "name": file_name(path),
      "mimeType": mime_type,
      "data": files::encode_base64(&bytes),
      "width": width,
      "height": height
    });
    let texture = bridge.call_with_timeout("texture.add", params, FILE_TIMEOUT).await?;
    json!({ "texture": texture, "width": width, "height": height })
  } else {
    let params = json!({ "format": format, "name": file_name(path), "base64": files::encode_base64(&bytes) });
    bridge.call_with_timeout("import.file", params, FILE_TIMEOUT).await?
  };

  let mut result = json!({ "imported": true, "path": path, "format": format, "bytes": bytes.len() });
  if let (Some(result), Some(imported)) = (result.as_object_mut(), imported.as_object()) {
    for (key, value) in imported {
      result.insert(key.clone(), value.clone());
    }
  }
  Ok(result)
}
