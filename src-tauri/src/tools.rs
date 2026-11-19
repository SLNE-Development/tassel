//! Tool dispatch: frontend commands plus the native tools that touch the file system.

use std::path::Path;
use std::time::Duration;

use serde_json::{Map, Value, json};

use crate::batch;
use crate::bridge::{CALL_TIMEOUT, Frontend};
use crate::files;

pub struct NativeTool {
  pub name: &'static str,
  pub description: &'static str,
  pub input_schema: Value,
}

/// An image a tool returned: `(base64, mimeType)`.
pub type Image = (String, String);

/// What a tool call produced. `is_error` results still carry a useful value (e.g. a partial batch).
pub struct ToolOutput {
  pub value: Value,
  pub is_error: bool,
  /// Images collected from the calls of a batch, in order; they become MCP image content.
  pub images: Vec<Image>,
}

impl ToolOutput {
  pub fn error(message: impl Into<String>) -> Self {
    Self { value: Value::String(message.into()), is_error: true, images: Vec::new() }
  }
}

const EXPORT_FORMATS: &str = ".glb (binary glTF, one self-contained file), .gltf (glTF JSON, everything embedded), \
  .obj (Wavefront OBJ with .mtl and texture images next to it), .stl, .ply, .usdz and .json (a Minecraft Java \
  block/item model, from Minecraft Java documents only)";
const IMPORT_FORMATS: &str =
  ".glb, .gltf, .obj, .stl, .ply and .fbx (3D models), or .png, .jpg and .webp (an image as a texture)";
const PLACE_FORMATS: &str = ".tessel (a Tessel project), .glb, .gltf, .obj, .stl, .ply and .fbx";
/// Parsing or writing a large file in the editor can take a while.
pub const FILE_TIMEOUT: Duration = Duration::from_secs(180);

const NATIVE_NAMES: [&str; 9] =
  ["file_save", "file_open", "file_export", "file_import", "scene_place_model", "material_import", "render_image", "render_video", "batch"];

pub fn is_native(tool: &str) -> bool {
  NATIVE_NAMES.contains(&tool)
}

fn document_id_schema() -> Value {
  json!({
    "type": "string",
    "description": "Id of an open document (see document_list) to work on instead of the active one, without switching tabs."
  })
}

pub fn native_tools() -> Vec<NativeTool> {
  let vec3 = |description: &str| {
    json!({ "type": "array", "items": { "type": "number" }, "minItems": 3, "maxItems": 3, "description": description })
  };
  vec![
    NativeTool {
      name: "file_save",
      description: "Save a document as a Tessel project file (.tessel, JSON) on disk and mark it as saved. \
        Pass an absolute path ending in .tessel to save to a new location (\"save as\"); omit path to save to the \
        file the document was opened from or last saved to (see activeDocument.filePath in app_get_state). \
        Missing parent folders are created; an existing file is overwritten. The document is renamed to the file \
        name. Returns { saved, path, id, name, bytes, objectCount } and, if the document name changed, renamedFrom \
        (its previous name).",
      input_schema: json!({
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Absolute path of the project file, ending in .tessel. Optional if the document already has a file path."
          },
          "documentId": document_id_schema()
        },
        "additionalProperties": false
      }),
    },
    NativeTool {
      name: "file_open",
      description: "Open a Tessel project file (.tessel), or a Minecraft Java block/item model (.json), from disk \
        in a new document tab. A .json model becomes a Minecraft Java document; its textures are read from the \
        resource pack it is in (assets/<namespace>/textures/...) or from next to the file, and textures that are \
        not found get a placeholder (listed in warnings). Returns \
        { opened, path, id, name, active }: id is the new document's id, to be passed as documentId to other \
        tools. By default the visible tab switches to it; with activate: false it opens in the background and \
        the user keeps looking at their current tab, while you can still work in it and take screenshots of it \
        through its documentId. Other open documents are not affected. To add the content of a project to the \
        current document instead, use scene_place_model.",
      input_schema: json!({
        "type": "object",
        "properties": {
          "path": { "type": "string", "description": "Absolute path of the project file (.tessel) or Minecraft Java model (.json)." },
          "activate": {
            "type": "boolean",
            "description": "true (default): switch the visible tab to the opened document. false: open it as a tab in the background and leave the user where they are."
          },
          "documentId": { "type": "string", "description": "Accepted for uniformity; opening always creates a new document." }
        },
        "required": ["path"],
        "additionalProperties": false
      }),
    },
    NativeTool {
      name: "file_export",
      description: "Export a document to a 3D file on disk for use in other tools and game engines. \
        The file extension chooses the format: .glb (binary glTF 2.0, one self-contained file with materials, \
        textures, UVs and the group hierarchy - usually what you want), .gltf (the same as JSON text with everything \
        embedded as base64), .obj (Wavefront OBJ: polygons stay polygons; the material library <name>.mtl and the \
        texture images <name>_<texture>.png are written into the same folder), .stl (binary, triangles only, for 3D \
        printing), .ply (binary, triangles with normals and UVs), .usdz (USD archive for AR viewers) or .json (a \
        Minecraft Java block/item model; only from Minecraft Java documents, written for their target version with \
        every element whose export flag is on; texture images are not written). Exported are \
        the visible objects as they look after their modifiers; .obj, .stl and .ply have no transforms, so they are \
        written in world space. Set selectionOnly to export just the selected objects. Missing parent folders are \
        created; existing files are overwritten. Returns { exported, path, format, bytes, files, selectionOnly }; \
        files lists the absolute path of every file written (the main file first). This does not save the project \
        - use file_save for that.",
      input_schema: json!({
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Absolute path of the exported file, ending in .glb, .gltf, .obj, .stl, .ply, .usdz or .json (Minecraft Java model)."
          },
          "selectionOnly": {
            "type": "boolean",
            "default": false,
            "description": "Export only the selected objects instead of the whole document."
          },
          "documentId": document_id_schema()
        },
        "required": ["path"],
        "additionalProperties": false
      }),
    },
    NativeTool {
      name: "file_import",
      description: "Import a file from disk into the document. A 3D model (.glb, .gltf, .obj, .stl, .ply, .fbx) \
        adds its meshes as new objects, with materials, embedded textures and the node hierarchy (as groups) where \
        the format has them, as one undo step; the new objects are selected. Only the one file is read: an .obj \
        comes in without its .mtl (materials are created by name with default values), and a .gltf must be \
        self-contained (use .glb otherwise). Triangle formats arrive as triangle meshes; FBX files are converted \
        to Y up and meters. An image (.png, .jpg, .jpeg, .webp) is added as a texture; put it on a material with \
        material_update { id, maps: { baseColor: textureId } }. Files up to 192 MB. Returns the ids and names of \
        what was added, and warnings about anything that was skipped. To put a model at a position as one group \
        (also a .tessel project), use scene_place_model.",
      input_schema: json!({
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Absolute path of the file to import: .glb, .gltf, .obj, .stl, .ply, .fbx, or an image (.png, .jpg, .jpeg, .webp)."
          },
          "documentId": document_id_schema()
        },
        "required": ["path"],
        "additionalProperties": false
      }),
    },
    NativeTool {
      name: "scene_place_model",
      description: "Place a model file from disk into the document as ONE unit: everything in the file is added \
        (one undo step) inside a single new group, positioned, rotated and scaled as given. Use it to assemble a \
        scene from parts you built or saved earlier - e.g. save a chair as chair.tessel once, then place it six \
        times. Formats: .tessel (merges that project's objects, groups, materials and textures), .glb, .gltf, \
        .obj, .stl, .ply, .fbx (see file_import for what each format carries), up to 192 MB. The model's own \
        origin is put at position (world space, meters, Y up); rotation is Euler XYZ in degrees about that point; \
        scale is uniform or per axis. Materials equal to ones the document already has are reused instead of \
        duplicated (reuseMaterials). Returns { placed, path, format, bytes, id and groupId (the new group), \
        objects, groups, materials, textures (each { id, name }), bounds: { min, max } (world), warnings }. \
        In a batch, label the call with \"as\" and refer to the group as \"$label\".",
      input_schema: json!({
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Absolute path of the model: .tessel, .glb, .gltf, .obj, .stl, .ply or .fbx."
          },
          "position": vec3("World position [x, y, z] in meters where the model's origin is placed. Default [0, 0, 0]."),
          "rotation": vec3("Rotation [x, y, z] as Euler XYZ angles in degrees, about the placement point. Default [0, 0, 0]."),
          "scale": {
            "description": "Scale factor: one number (uniform) or [x, y, z]. Default 1.",
            "anyOf": [
              { "type": "number" },
              { "type": "array", "items": { "type": "number" }, "minItems": 3, "maxItems": 3 }
            ]
          },
          "groupId": {
            "type": ["string", "null"],
            "description": "Parent group (id or name) that the new group is put into. Default: top level."
          },
          "name": { "type": "string", "description": "Name of the new group. Default: the file name without extension." },
          "reuseMaterials": {
            "type": "boolean",
            "default": true,
            "description": "Reuse materials of the document that are equal to imported ones (same name and values) instead of adding copies."
          },
          "documentId": document_id_schema()
        },
        "required": ["path"],
        "additionalProperties": false
      }),
    },
    NativeTool {
      name: "material_import",
      description: "Copy materials (with the textures they use) from another Tessel project file (.tessel) on \
        disk into the document, as one undo step, so that models share one material library. names picks the \
        materials by name; without it all are copied. A material equal to an existing one (same name and same \
        values and maps) is reused instead of duplicated. Returns { imported, path, materials: [{ id, name, \
        reused }] } and, when exactly one material came back, its id as id (so \"$label\" works in a batch).",
      input_schema: json!({
        "type": "object",
        "properties": {
          "path": { "type": "string", "description": "Absolute path of the project file to take materials from, ending in .tessel." },
          "names": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Names of the materials to copy. Default: all materials of that project."
          },
          "documentId": document_id_schema()
        },
        "required": ["path"],
        "additionalProperties": false
      }),
    },
    NativeTool {
      name: "render_video",
      description: "Export the animation of a document as a video file on disk: one picture per animation frame from \
        fromFrame to toFrame (default: the whole animation, frames 0 .. frameCount - 1) at the animation's frame rate, \
        so the video lasts (toFrame - fromFrame + 1) / fps seconds. Workflow: animate with the anim_* tools, check the \
        timing with anim_evaluate and single pictures with view_screenshot { frame }, then call this. The file \
        extension chooses the container: .mp4 (H.264, plays everywhere; on a system without an H.264 encoder VP9 or \
        AV1 in MP4 - the result says which codec was used) or .webm (VP9). Missing folders are created, an existing \
        file is overwritten. quality \"viewport\" (default) is the editor look of view_screenshot (studio light, \
        grid, the chosen shading) and fast: typically dozens of frames per second at 1280 x 720. quality \"render\" \
        path traces every frame like render_image with the render settings of the document; each frame gets samples \
        samples per pixel but at most maxSecondsPerFrame seconds, so the export takes about frames x \
        maxSecondsPerFrame seconds and is refused above one hour of that budget. With camera keys in the document \
        (anim_set_camera_key, anim_camera_orbit) the video looks through the animated camera; otherwise, or when \
        view or camera is given, one fixed camera is used for the whole video (view \"current\" = the camera of that \
        document's viewport; a preset frames the scene once on the first frame). Pictures show no selection \
        highlight, gizmo or edit-mode overlay. Width and height are rounded to even numbers. Limits: at most 10 \
        minutes of 3840 x 2160 at 30 fps (frames x pixels) and at most 256 MB by bitrate x length; beyond that the \
        call fails and says what fits. Nothing in the document or in what the user sees changes, other tool calls \
        are not blocked while it runs, and documentId exports a document in the background. Returns { exported, \
        path, bytes, frames, fps, seconds (length of the video), width, height, codec, codecName, format, bitrate, \
        quality, camera (\"animated\" or \"fixed\"), fromFrame, toFrame, elapsedSeconds, framesPerSecond, warnings? }.",
      input_schema: json!({
        "type": "object",
        "properties": {
          "path": { "type": "string", "description": "Absolute path of the video file, ending in .mp4 or .webm." },
          "fromFrame": { "type": "integer", "minimum": 0, "description": "First frame. Default 0." },
          "toFrame": { "type": "integer", "minimum": 0, "description": "Last frame (included). Default: the last frame of the animation, frameCount - 1 (see anim_get)." },
          "width": { "type": "integer", "minimum": 64, "maximum": 4096, "default": 1280, "description": "Width in pixels (rounded to an even number)." },
          "height": { "type": "integer", "minimum": 64, "maximum": 4096, "default": 720, "description": "Height in pixels (rounded to an even number)." },
          "quality": { "type": "string", "enum": ["viewport", "render"], "default": "viewport", "description": "viewport: editor look, fast. render: path traced, each frame takes up to maxSecondsPerFrame." },
          "format": { "type": "string", "enum": ["mp4", "webm"], "description": "Follows from the file extension; if given it must agree with it." },
          "bitrate": { "type": "number", "minimum": 100000, "maximum": 200000000, "description": "Bits per second. Default: about 0.12 bits per pixel and frame (3.3 Mbit/s for 1280 x 720 at 30 fps)." },
          "samples": { "type": "integer", "minimum": 1, "maximum": 100000, "description": "Render quality only: samples per pixel and frame. Default 24." },
          "maxSecondsPerFrame": { "type": "number", "minimum": 1, "maximum": 600, "description": "Render quality only: time budget per frame in seconds. Default 3." },
          "view": {
            "type": "string",
            "enum": ["current", "front", "back", "left", "right", "top", "bottom", "iso"],
            "description": "A fixed view for the whole video instead of the animated camera: \"current\" = the camera of that document's viewport; a preset names the side the camera is on (front = on +Z, right = on +X, top = on +Y) and frames the scene."
          },
          "camera": {
            "type": "object",
            "description": "A fixed camera for the whole video instead of the animated one: { position: [x, y, z], target: [x, y, z], fov?: vertical degrees }. World coordinates, Y up.",
            "properties": { "position": vec3("Where the camera is."), "target": vec3("The point it looks at."), "fov": { "type": "number", "minimum": 5, "maximum": 120 } },
            "required": ["position", "target"]
          },
          "shading": { "type": "string", "enum": ["solid", "wireframe", "material"], "description": "Viewport quality only: solid (neutral clay), wireframe or material (PBR materials and textures). Default: the current viewport shading." },
          "hideIds": { "type": "array", "items": { "type": "string" }, "description": "Objects (ids or names, * and ? globs) left out of the video." },
          "documentId": document_id_schema()
        },
        "required": ["path"],
        "additionalProperties": false
      }),
    },
    NativeTool {
      name: "batch",
      description: "Run many tool calls in order with ONE request - the fast way to build anything bigger than a \
        few objects. Recommended workflow: write a script that generates a JSON file with the commands, then call \
        batch { \"file\": \"C:\\\\work\\\\build.json\" }; nothing has to be typed into the conversation and hundreds of \
        commands run in about a second. The file contains an array of commands or { \"commands\": [...] } (UTF-8, \
        at most 16 MB, at most 20000 commands). Alternatively pass the commands inline. \
        A command is { tool, params?, as? }. Any tool except batch can be used. \
        References instead of copying ids: give a command a label with \"as\": \"leg\", and use the string \
        \"$leg\" anywhere inside the params of a LATER command; it is replaced by the id field of that command's \
        result. \"$leg.path\" reads another field by dot path, numbers index arrays (\"$grp.objects.0.id\", \
        \"$box.bounds.max.1\"); the value keeps its JSON type. \"$3\" refers to the command with 0-based index 3, \
        \"$prev\" to the command directly before. Only whole strings are references (no interpolation); write \
        \"$$...\" for a literal string starting with $. Objects, groups and materials can also be referenced by \
        name where an id is expected, so known names need no reference at all. \
        The batch is checked before anything runs (shape, tool names, labels, references); such problems execute \
        nothing. Then execution stops at the first failing command (earlier ones stay applied, each is its own \
        undo step) unless continueOnError is true. validateOnly runs nothing and additionally checks every \
        command's params against its schema - use it first for big files. \
        resultMode: \"full\" = every result (default for inline commands); \"ids\" = only identifying fields per \
        command: id, name, ids, objectId, objectIds, groupId, materialId, textureId, layerId, modifierId and \
        objects/groups/materials/textures as { id, name } (default for file); \"summary\" = counts, errors and \
        labels only. Every result has total, completed, failed, errors: [{ index, tool, as, message }], labels: \
        { label: id }, objectCount and document: { id, name } after the batch. Screenshots (view_screenshot) come \
        back as images in every mode (summary: only the last), so end a batch with one to see the result. \
        documentId runs the whole batch against that open document without switching tabs.",
      input_schema: json!({
        "type": "object",
        "properties": {
          "commands": {
            "type": "array",
            "minItems": 1,
            "description": "The tool calls to run, in order. Pass either commands or file.",
            "items": {
              "type": "object",
              "properties": {
                "tool": { "type": "string", "description": "Tool name, e.g. scene_add_primitive." },
                "params": {
                  "type": "object",
                  "description": "Arguments of that tool. Defaults to {}. String values of the form \"$label\", \"$label.path\", \"$<index>\" or \"$prev\" are replaced by results of earlier commands."
                },
                "as": {
                  "type": "string",
                  "description": "Label for this command's result (letters, digits, _ and -; unique; not only digits and not \"prev\"), referenced by later commands as \"$label\"."
                }
              },
              "required": ["tool"],
              "additionalProperties": false
            }
          },
          "file": {
            "type": "string",
            "description": "Absolute path of a .json file with the commands: an array, or an object { \"commands\": [...] }. Pass either commands or file."
          },
          "resultMode": {
            "type": "string",
            "enum": ["full", "ids", "summary"],
            "description": "How much of the results to return. Default: full for commands, ids for file."
          },
          "continueOnError": {
            "type": "boolean",
            "default": false,
            "description": "Keep going after a failed command and report all errors. A command that references a failed one fails too."
          },
          "validateOnly": {
            "type": "boolean",
            "default": false,
            "description": "Run nothing; check the file, tool names, labels, references and every command's params. Returns { valid, commands, errors, warnings?, paramsValidated }."
          },
          "documentId": document_id_schema()
        },
        "additionalProperties": false
      }),
    },
    NativeTool {
      name: "render_image",
      description: "Render a presentation-quality picture of a document by path tracing: physically based light with \
        soft shadows, light bouncing between surfaces, reflections in metals, emissive materials that light their \
        surroundings. Use this for pictures that are shown to someone, and view_screenshot (instant, editor look) for \
        quick checks while modelling. Rendered are the visible objects as displayed, with their materials and textures, \
        without grid or selection; nothing in the document or in what the user sees changes. The look (lighting \
        environment, sun, background, ground, camera, image size, quality) comes from the render settings of the \
        document - see render_get_settings for all of them and their meaning, render_set_settings to store them - and \
        every parameter here overrides them for this one picture. With path the image is also written to that file \
        (absolute; .png, .jpg / .jpeg or .webp, which chooses the format; missing folders are created, an existing \
        file is overwritten). The picture is refined until samples is reached or maxSeconds of sampling are over; \
        preparing the scene comes on top, and the first render after the app starts compiles the renderer, which \
        can take up to a minute once per computer. On integrated graphics 1280 x 720 gets about 3-5 samples per \
        second; a draft needs about 30 samples, a clean picture 150-500. Other tool calls are not blocked while a \
        render runs. Returns the image and { rendered, path?, bytes?, width, height, samples, seconds, converged, \
        camera: { position, target, fov, direction, imageRight, imageUp } }; converged false means the time ran out \
        before the sample count was reached (raise maxSeconds or lower the size if it looks grainy). An image \
        written to path that is larger than about 4 MB is not also returned inline unless returnImage is true.",
      input_schema: json!({
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "description": "Optional absolute path to also write the image to, ending in .png, .jpg, .jpeg or .webp."
          },
          "returnImage": {
            "type": "boolean",
            "description": "Return the image inline as well. Default: true, except for an image larger than about 4 MB that was written to path."
          },
          "width": { "type": "integer", "minimum": 16, "maximum": 4096, "description": "Image width in pixels. Default: the setting of the document (1280)." },
          "height": { "type": "integer", "minimum": 16, "maximum": 4096, "description": "Image height in pixels. Default: the setting of the document (720)." },
          "samples": { "type": "integer", "minimum": 1, "maximum": 100000, "description": "Samples per pixel to aim for. Default: the setting of the document (128)." },
          "maxSeconds": { "type": "number", "minimum": 1, "maximum": 600, "description": "Time budget for sampling in seconds. Default: the setting of the document (30)." },
          "view": {
            "type": "string",
            "enum": ["current", "front", "back", "left", "right", "top", "bottom", "iso"],
            "description": "\"current\" = the camera of the viewport of that document; a preset names the side the camera is on (front = on +Z, right = on +X, top = on +Y, iso = on the (+X, +Y, +Z) side) and always frames the scene. Default: the setting of the document (current)."
          },
          "camera": {
            "type": "object",
            "description": "Render from this camera instead of view: { position: [x, y, z], target: [x, y, z], fov?: vertical degrees }. World coordinates, Y up.",
            "properties": { "position": vec3("Where the camera is."), "target": vec3("The point it looks at."), "fov": { "type": "number", "minimum": 5, "maximum": 120 } },
            "required": ["position", "target"]
          },
          "fit": {
            "description": "true: move the camera along its viewing direction until everything rendered is in frame. A list of object ids or names frames just those.",
            "anyOf": [{ "type": "boolean" }, { "type": "array", "items": { "type": "string" } }]
          },
          "hideIds": { "type": "array", "items": { "type": "string" }, "description": "Objects (ids or names, * and ? globs) left out of this picture only." },
          "focusOn": { "type": "string", "description": "For depth of field: the object (id or name) that is in focus." },
          "frame": { "type": "number", "minimum": 0, "description": "Animation frame to render (fractional allowed; time = frame / fps): the document as its animation shows it at that frame, and - if it has camera keys and neither view nor camera is given - through its animated camera. Default: the static pose." },
          "useAnimationCamera": { "type": "boolean", "description": "With frame: false keeps the normal camera although there are camera keys; true insists on the animated camera." },
          "format": { "type": "string", "enum": ["png", "jpeg", "webp"], "description": "Image format; with path it follows from the file extension. Default: the setting of the document (png)." },
          "environment": { "type": "object", "description": "{ preset?: outdoor | studio | sunset | night | neutral, intensity?, rotation? (degrees) } - the surroundings that light the scene." },
          "sun": { "type": "object", "description": "{ enabled?, azimuth? (degrees: 0 = towards +Z, 90 = towards +X), elevation? (degrees above the horizon), intensity? (4 = sunny day), softness? (degrees, 0.5 = hard shadows, 10 = very soft) }. Shadows fall away from the sun." },
          "background": { "type": "object", "description": "{ type?: environment | color | gradient | transparent, color? (#rrggbb; flat colour or bottom of the gradient), topColor? }. transparent needs png or webp." },
          "ground": { "type": "object", "description": "{ type?: plane | none, color? (#rrggbb), reflectivity? (0..1) } - a ground at the lowest point that catches the shadows." },
          "depthOfField": { "type": "object", "description": "{ enabled?, fStop?, focusDistance? (meters, null = distance to the camera target) }." },
          "output": { "type": "object", "description": "{ bounces? (1..16), denoise? (0..1), toneMapping?: aces | agx | neutral, exposure? (stops), quality? (jpeg / webp, 0.1..1) }." },
          "documentId": document_id_schema()
        },
        "additionalProperties": false
      }),
    },
  ]
}

/// Runs any tool by its MCP name.
pub async fn call<F: Frontend>(frontend: &F, tool: &str, args: Value) -> ToolOutput {
  if tool == "batch" {
    return batch::run(frontend, args).await;
  }
  match call_single(frontend, tool, args).await {
    Ok(value) => ToolOutput { value, is_error: false, images: Vec::new() },
    Err(message) => ToolOutput::error(message),
  }
}

pub const NESTED_BATCH: &str = "batch cannot be nested inside batch";

/// Runs any tool except `batch`.
pub async fn call_single<F: Frontend>(frontend: &F, tool: &str, args: Value) -> Result<Value, String> {
  match tool {
    "file_save" => file_save(frontend, &args).await,
    "file_open" => file_open(frontend, &args).await,
    "file_export" => file_export(frontend, &args).await,
    "file_import" => file_import(frontend, &args).await,
    "scene_place_model" => scene_place_model(frontend, &args).await,
    "material_import" => material_import(frontend, &args).await,
    "render_image" => render_image(frontend, &args).await,
    "render_video" => render_video(frontend, &args).await,
    "batch" => Err(NESTED_BATCH.into()),
    _ => match frontend.command_id(tool) {
      Some(command) => frontend.call(&command, args, CALL_TIMEOUT).await,
      None => Err(unknown_tool(frontend, tool)),
    },
  }
}

pub fn unknown_tool<F: Frontend>(frontend: &F, tool: &str) -> String {
  let tool = short(tool);
  if !frontend.is_ready() {
    format!("Unknown tool \"{tool}\". The Tessel editor window has not registered its commands yet - try again in a moment.")
  } else if tool.contains('.') {
    format!(
      "Unknown tool \"{tool}\". Tool names use underscores, e.g. \"{}\"; use tools/list to see the available tools.",
      tool.replace('.', "_")
    )
  } else {
    format!("Unknown tool \"{tool}\". Use tools/list to see the available tools.")
  }
}

/// Checks the arguments of a native tool as far as that is possible without touching the disk or the
/// editor (used by `batch { validateOnly }`). Tools that are not native pass.
pub fn check_native(tool: &str, args: &Value) -> Result<(), String> {
  match tool {
    "file_save" => SaveArgs::parse(args).map(drop),
    "file_open" => OpenArgs::parse(args).map(drop),
    "file_export" => ExportArgs::parse(args).map(drop),
    "file_import" => ImportArgs::parse(args).map(drop),
    "scene_place_model" => PlaceArgs::parse(args).map(drop),
    "material_import" => MaterialImportArgs::parse(args).map(drop),
    "render_image" => RenderArgs::parse(args).map(drop),
    "render_video" => VideoArgs::parse(args).map(drop),
    _ => Ok(()),
  }
}

/// Removes and returns `(base64, mimeType)` if `value` is an object with a well-formed `image` field.
pub fn take_image(value: &mut Value) -> Option<Image> {
  let object = value.as_object_mut()?;
  let image = object.get("image")?;
  let base64 = image.get("base64")?.as_str()?.to_string();
  let mime_type = image.get("mimeType")?.as_str()?.to_string();
  object.remove("image");
  Some((base64, mime_type))
}

/// Id, name and object count of an open document, from `document.list`.
pub struct DocumentInfo {
  pub id: Value,
  pub name: Value,
  pub object_count: Value,
}

/// Looks up an open document: the one with `id`, or the active one without.
pub async fn document_info<F: Frontend>(frontend: &F, id: Option<&str>) -> Option<DocumentInfo> {
  let list = frontend.call("document.list", json!({}), CALL_TIMEOUT).await.ok()?;
  let document = list.get("documents")?.as_array()?.iter().find(|document| match id {
    Some(id) => document.get("id").and_then(Value::as_str) == Some(id),
    None => document.get("active").and_then(Value::as_bool) == Some(true),
  })?;
  let field = |key: &str| document.get(key).cloned().unwrap_or(Value::Null);
  Some(DocumentInfo { id: field("id"), name: field("name"), object_count: field("objectCount") })
}

/// Shortens untrusted text for an error message.
pub fn short(text: &str) -> String {
  const MAX: usize = 80;
  if text.chars().count() <= MAX {
    text.to_string()
  } else {
    format!("{}...", text.chars().take(MAX).collect::<String>())
  }
}

// ---- argument checks -------------------------------------------------------------------------

fn object<'a>(args: &'a Value, tool: &str, allowed: &[&str]) -> Result<&'a Map<String, Value>, String> {
  let Some(map) = args.as_object() else {
    return Err(format!("The arguments of {tool} must be an object"));
  };
  match map.keys().find(|key| !allowed.contains(&key.as_str())) {
    Some(key) => Err(format!("Unknown parameter \"{}\" for {tool}. Parameters: {}.", short(key), allowed.join(", "))),
    None => Ok(map),
  }
}

/// An optional string parameter: absent or null is None; anything but a non-empty string is an error.
fn opt_str<'a>(map: &'a Map<String, Value>, key: &str) -> Result<Option<&'a str>, String> {
  match map.get(key) {
    None | Some(Value::Null) => Ok(None),
    Some(Value::String(text)) if !text.trim().is_empty() => Ok(Some(text.trim())),
    Some(_) => Err(format!("\"{key}\" must be a non-empty string")),
  }
}

fn req_str<'a>(map: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
  opt_str(map, key)?.ok_or_else(|| format!("\"{key}\" is required"))
}

fn opt_bool(map: &Map<String, Value>, key: &str) -> Result<Option<bool>, String> {
  match map.get(key) {
    None | Some(Value::Null) => Ok(None),
    Some(Value::Bool(flag)) => Ok(Some(*flag)),
    Some(_) => Err(format!("\"{key}\" must be true or false")),
  }
}

fn is_vec3(value: &Value) -> bool {
  value.as_array().is_some_and(|items| items.len() == 3 && items.iter().all(Value::is_number))
}

fn require_absolute(path: &str) -> Result<(), String> {
  if Path::new(path).is_absolute() {
    Ok(())
  } else {
    let extension = Some(files::extension(path)).filter(|e| !e.is_empty()).unwrap_or_else(|| "tessel".into());
    Err(format!(
      "\"{}\" is not an absolute path. Pass a full path such as C:\\Models\\chair.{}.",
      short(path),
      short(&extension)
    ))
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

fn file_name(path: &str) -> String {
  Path::new(path)
    .file_name()
    .map(|s| s.to_string_lossy().into_owned())
    .unwrap_or_default()
}

fn field<'a>(value: &'a Value, key: &str, command: &str) -> Result<&'a str, String> {
  value
    .get(key)
    .and_then(Value::as_str)
    .ok_or_else(|| format!("The editor returned no \"{key}\" from {command}"))
}

/// Adds the optional `documentId` to the params of a forwarded command.
fn with_document(mut params: Value, document_id: Option<&str>) -> Value {
  if let (Some(id), Some(map)) = (document_id, params.as_object_mut()) {
    map.insert("documentId".into(), json!(id));
  }
  params
}

/// `base` plus every field of `extra` (an object the editor returned); `base` wins on a clash.
fn merged(mut base: Value, extra: &Value) -> Value {
  if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
    for (key, value) in extra {
      base.entry(key.clone()).or_insert_with(|| value.clone());
    }
  }
  base
}

struct SaveArgs<'a> {
  path: Option<&'a str>,
  document_id: Option<&'a str>,
}

impl<'a> SaveArgs<'a> {
  fn parse(args: &'a Value) -> Result<Self, String> {
    let map = object(args, "file_save", &["path", "documentId"])?;
    let path = opt_str(map, "path")?;
    // Validate an explicit path before bothering the frontend.
    if let Some(path) = path {
      require_tessel(path)?;
    }
    Ok(Self { path, document_id: opt_str(map, "documentId")? })
  }
}

struct OpenArgs<'a> {
  path: &'a str,
  /// Whether the visible tab switches to the opened document; None leaves that to the editor (it does).
  activate: Option<bool>,
  document_id: Option<&'a str>,
}

impl<'a> OpenArgs<'a> {
  fn parse(args: &'a Value) -> Result<Self, String> {
    let map = object(args, "file_open", &["path", "activate", "documentId"])?;
    let path = req_str(map, "path")?;
    if files::extension(path) == "json" {
      require_absolute(path)?;
    } else {
      require_tessel(path)?;
    }
    Ok(Self { path, activate: opt_bool(map, "activate")?, document_id: opt_str(map, "documentId")? })
  }
}

struct ExportArgs<'a> {
  path: &'a str,
  format: String,
  selection_only: bool,
  document_id: Option<&'a str>,
}

impl<'a> ExportArgs<'a> {
  fn parse(args: &'a Value) -> Result<Self, String> {
    let map = object(args, "file_export", &["path", "selectionOnly", "documentId"])?;
    let path = req_str(map, "path")?;
    require_absolute(path)?;
    let format = files::extension(path);
    if format.is_empty() {
      return Err(format!("\"{path}\" has no file extension. Supported export formats: {EXPORT_FORMATS}."));
    }
    if !files::EXPORT_EXTENSIONS.contains(&format.as_str()) {
      return Err(format!("Cannot export to .{format}. Supported export formats: {EXPORT_FORMATS}."));
    }
    Ok(Self {
      path,
      format,
      selection_only: opt_bool(map, "selectionOnly")?.unwrap_or(false),
      document_id: opt_str(map, "documentId")?,
    })
  }
}

struct ImportArgs<'a> {
  path: &'a str,
  format: String,
  is_image: bool,
  document_id: Option<&'a str>,
}

impl<'a> ImportArgs<'a> {
  fn parse(args: &'a Value) -> Result<Self, String> {
    let map = object(args, "file_import", &["path", "documentId"])?;
    let path = req_str(map, "path")?;
    require_absolute(path)?;
    let format = files::extension(path);
    let is_image = files::IMAGE_EXTENSIONS.contains(&format.as_str());
    if format.is_empty() {
      return Err(format!("\"{path}\" has no file extension. Supported import formats: {IMPORT_FORMATS}."));
    }
    if !is_image && !files::IMPORT_EXTENSIONS.contains(&format.as_str()) {
      let hint = if format == "tessel" {
        " Use file_open to open a .tessel project in a new tab, or scene_place_model to add its content to this document."
      } else {
        ""
      };
      return Err(format!("Cannot import .{format} files. Supported import formats: {IMPORT_FORMATS}.{hint}"));
    }
    Ok(Self { path, format, is_image, document_id: opt_str(map, "documentId")? })
  }
}

struct PlaceArgs<'a> {
  path: &'a str,
  format: String,
  /// Placement params as `import.file` takes them (without the file itself).
  placement: Map<String, Value>,
  document_id: Option<&'a str>,
}

impl<'a> PlaceArgs<'a> {
  fn parse(args: &'a Value) -> Result<Self, String> {
    const KEYS: [&str; 8] = ["path", "position", "rotation", "scale", "groupId", "name", "reuseMaterials", "documentId"];
    let map = object(args, "scene_place_model", &KEYS)?;
    let path = req_str(map, "path")?;
    require_absolute(path)?;
    let format = files::extension(path);
    if format.is_empty() {
      return Err(format!("\"{path}\" has no file extension. scene_place_model reads {PLACE_FORMATS}."));
    }
    if format != "tessel" && !files::IMPORT_EXTENSIONS.contains(&format.as_str()) {
      let hint = if files::IMAGE_EXTENSIONS.contains(&format.as_str()) {
        " Use file_import to add an image as a texture."
      } else {
        ""
      };
      return Err(format!("Cannot place .{format} files. scene_place_model reads {PLACE_FORMATS}.{hint}"));
    }

    let mut placement = Map::new();
    for key in ["position", "rotation"] {
      match map.get(key) {
        None | Some(Value::Null) => {}
        Some(value) if is_vec3(value) => {
          placement.insert(key.into(), value.clone());
        }
        Some(_) => return Err(format!("\"{key}\" must be an array of three numbers [x, y, z]")),
      }
    }
    match map.get("scale") {
      None | Some(Value::Null) => {}
      Some(value) if value.is_number() || is_vec3(value) => {
        placement.insert("scale".into(), value.clone());
      }
      Some(_) => return Err("\"scale\" must be a number or an array of three numbers [x, y, z]".into()),
    }
    match map.get("groupId") {
      None => {}
      Some(Value::Null) => {
        placement.insert("groupId".into(), Value::Null);
      }
      Some(Value::String(group)) if !group.is_empty() => {
        placement.insert("groupId".into(), json!(group));
      }
      Some(_) => return Err("\"groupId\" must be a group id or name, or null for the top level".into()),
    }
    let name = match opt_str(map, "name")? {
      Some(name) => name.to_string(),
      None => Some(file_stem(path).trim().to_string())
        .filter(|stem| !stem.is_empty())
        .unwrap_or_else(|| "Model".into()),
    };
    placement.insert("groupName".into(), json!(name));
    if let Some(reuse) = opt_bool(map, "reuseMaterials")? {
      placement.insert("reuseMaterials".into(), json!(reuse));
    }
    Ok(Self { path, format, placement, document_id: opt_str(map, "documentId")? })
  }
}

struct MaterialImportArgs<'a> {
  path: &'a str,
  names: Option<&'a Value>,
  document_id: Option<&'a str>,
}

impl<'a> MaterialImportArgs<'a> {
  fn parse(args: &'a Value) -> Result<Self, String> {
    let map = object(args, "material_import", &["path", "names", "documentId"])?;
    let path = req_str(map, "path")?;
    require_tessel(path)?;
    let names = match map.get("names") {
      None | Some(Value::Null) => None,
      Some(names) => {
        let valid = names
          .as_array()
          .is_some_and(|items| items.iter().all(|name| name.as_str().is_some_and(|name| !name.is_empty())));
        if !valid {
          return Err("\"names\" must be an array of material names".into());
        }
        Some(names)
      }
    };
    Ok(Self { path, names, document_id: opt_str(map, "documentId")? })
  }
}

// ---- the tools -------------------------------------------------------------------------------

async fn file_save<F: Frontend>(frontend: &F, args: &Value) -> Result<Value, String> {
  let args = SaveArgs::parse(args)?;
  let target = match args.document_id {
    Some(id) => json!({ "id": id }),
    None => json!({}),
  };
  let doc = frontend.call("document.serialize", target, CALL_TIMEOUT).await?;
  let path = match args.path.or_else(|| doc.get("filePath").and_then(Value::as_str)) {
    Some(path) => path.to_string(),
    None => {
      return Err(
        "This document has never been saved, so a path is required: pass an absolute path ending in .tessel.".into(),
      );
    }
  };
  require_tessel(&path)?;

  let json = field(&doc, "json", "document.serialize")?;
  files::write_bytes(&path, json.as_bytes()).await?;

  let name = file_stem(&path);
  let id = doc.get("id").and_then(Value::as_str).or(args.document_id);
  let mut mark = Map::new();
  if let Some(id) = id {
    mark.insert("id".into(), json!(id));
  }
  mark.insert("filePath".into(), json!(path));
  mark.insert("name".into(), json!(name));
  frontend.call("document.mark_saved", Value::Object(mark), CALL_TIMEOUT).await?;

  let mut result = json!({ "saved": true, "path": path, "name": name, "bytes": json.len() });
  if let Some(id) = id {
    result["id"] = json!(id);
  }
  // The document takes the name of its file; say so when that changed it.
  if let Some(previous) = doc.get("name").and_then(Value::as_str).filter(|previous| *previous != name) {
    result["renamedFrom"] = json!(previous);
  }
  if let Some(info) = document_info(frontend, id).await {
    result["objectCount"] = info.object_count;
  }
  Ok(result)
}

async fn file_open<F: Frontend>(frontend: &F, args: &Value) -> Result<Value, String> {
  let args = OpenArgs::parse(args)?;
  let path = args.path;
  if files::extension(path) == "json" {
    // A Minecraft Java model: a new Minecraft document, with the texture images that can be found.
    let read = files::read_java_model(path).await?;
    let stem = file_stem(path);
    let mut params = json!({ "json": read["json"], "images": read["images"], "name": stem, "fileName": stem });
    if let Some(activate) = args.activate {
      params["activate"] = json!(activate);
    }
    let opened = frontend.call("document.import_java", with_document(params, args.document_id), FILE_TIMEOUT).await?;
    return Ok(merged(json!({ "opened": true, "path": path }), &opened));
  }
  let json = files::read_text(path).await?;
  let mut params = json!({ "json": json, "filePath": path, "name": file_stem(path) });
  if let Some(activate) = args.activate {
    params["activate"] = json!(activate);
  }
  let opened = frontend.call("document.load", with_document(params, args.document_id), CALL_TIMEOUT).await?;
  Ok(merged(json!({ "opened": true, "path": path }), &opened))
}

async fn file_export<F: Frontend>(frontend: &F, args: &Value) -> Result<Value, String> {
  let ExportArgs { path, format, selection_only, document_id } = ExportArgs::parse(args)?;

  let params = json!({ "format": format, "selectionOnly": selection_only, "name": file_stem(path) });
  let exported = frontend.call("export.file", with_document(params, document_id), FILE_TIMEOUT).await?;

  let mut written = vec![path.to_string()];
  let bytes = if format == "obj" {
    let text = field(&exported, "text", "export.file")?;
    let side_files: Vec<files::SideFile> = match exported.get("files") {
      Some(list) => serde_json::from_value(list.clone())
        .map_err(|e| format!("The editor returned invalid side files from export.file: {e}"))?,
      None => Vec::new(),
    };
    let names = files::write_obj_bundle(
      path,
      text,
      field(&exported, "mtlName", "export.file")?,
      field(&exported, "mtl", "export.file")?,
      &side_files,
    )
    .await?;
    // The side files are next to the .obj; report every file with its full path.
    let folder = Path::new(path).parent().unwrap_or(Path::new(""));
    written.extend(names.iter().skip(1).map(|name| folder.join(name).to_string_lossy().into_owned()));
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

async fn file_import<F: Frontend>(frontend: &F, args: &Value) -> Result<Value, String> {
  let ImportArgs { path, format, is_image, document_id } = ImportArgs::parse(args)?;
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
    let texture = frontend.call("texture.add", with_document(params, document_id), FILE_TIMEOUT).await?;
    json!({ "texture": texture, "width": width, "height": height })
  } else {
    let params = json!({ "format": format, "name": file_name(path), "base64": files::encode_base64(&bytes) });
    frontend.call("import.file", with_document(params, document_id), FILE_TIMEOUT).await?
  };

  Ok(merged(json!({ "imported": true, "path": path, "format": format, "bytes": bytes.len() }), &imported))
}

async fn scene_place_model<F: Frontend>(frontend: &F, args: &Value) -> Result<Value, String> {
  let PlaceArgs { path, format, placement, document_id } = PlaceArgs::parse(args)?;
  let bytes = files::read_bytes_limited(path).await?;
  if bytes.is_empty() {
    return Err(format!("\"{path}\" is empty"));
  }

  let mut params = placement;
  params.insert("format".into(), json!(format));
  params.insert("name".into(), json!(file_name(path)));
  if format == "tessel" {
    let text =
      files::decode_text(&bytes).map_err(|problem| format!("\"{path}\" is not a Tessel project file: {problem}"))?;
    params.insert("text".into(), json!(text));
  } else {
    params.insert("base64".into(), json!(files::encode_base64(&bytes)));
  }
  let placed = frontend
    .call("import.file", with_document(Value::Object(params), document_id), FILE_TIMEOUT)
    .await?;

  let mut result = json!({ "placed": true, "path": path, "format": format, "bytes": bytes.len() });
  // The new group is what was placed, so its id is the id of this result ("$label" in a batch).
  if let Some(group) = placed.get("groupId").filter(|group| group.is_string()) {
    result["id"] = group.clone();
  }
  Ok(merged(result, &placed))
}

async fn material_import<F: Frontend>(frontend: &F, args: &Value) -> Result<Value, String> {
  let MaterialImportArgs { path, names, document_id } = MaterialImportArgs::parse(args)?;
  let bytes = files::read_bytes_limited(path).await?;
  let json =
    files::decode_text(&bytes).map_err(|problem| format!("\"{path}\" is not a Tessel project file: {problem}"))?;
  if json.trim().is_empty() {
    return Err(format!("\"{path}\" is empty"));
  }

  let mut params = json!({ "json": json });
  if let Some(names) = names {
    params["names"] = names.clone();
  }
  let imported = frontend.call("material.import", with_document(params, document_id), FILE_TIMEOUT).await?;

  let mut result = json!({ "imported": true, "path": path });
  if let Some([only]) = imported.get("materials").and_then(Value::as_array).map(Vec::as_slice)
    && let Some(id) = only.get("id").filter(|id| id.is_string())
  {
    result["id"] = id.clone();
  }
  Ok(merged(result, &imported))
}

const RENDER_PARAMS: [&str; 21] = [
  "path", "returnImage", "width", "height", "samples", "maxSeconds", "view", "camera", "fit", "hideIds", "focusOn",
  "format", "environment", "sun", "background", "ground", "depthOfField", "output", "documentId",
  "frame", "useAnimationCamera",
];
/// Longest sampling time `render.image` accepts, in seconds.
const RENDER_MAX_SECONDS: f64 = 600.0;
/// Time a render may take on top of its sampling budget: preparing the scene, compiling the renderer
/// the first time, waiting for a render that is already running, encoding the image.
const RENDER_MARGIN: Duration = Duration::from_secs(240);
/// Above this much base64, an image that was written to a file is not also returned inline.
const RENDER_INLINE_LIMIT: usize = 4 * 1024 * 1024;

/// How long to wait for a render with the given sampling budget (None: the one of the document, at most the maximum).
pub fn render_timeout(max_seconds: Option<f64>) -> Duration {
  Duration::from_secs_f64(max_seconds.unwrap_or(RENDER_MAX_SECONDS).clamp(1.0, RENDER_MAX_SECONDS)) + RENDER_MARGIN
}

struct RenderArgs<'a> {
  path: Option<&'a str>,
  return_image: Option<bool>,
  /// The arguments for `render.image`: everything but `path` and `returnImage`, with `format` set from the path.
  params: Value,
  timeout: Duration,
}

impl<'a> RenderArgs<'a> {
  fn parse(args: &'a Value) -> Result<Self, String> {
    let map = object(args, "render_image", &RENDER_PARAMS)?;
    let path = opt_str(map, "path")?;
    let format = opt_str(map, "format")?;
    if let Some(format) = format
      && !["png", "jpeg", "webp"].contains(&format)
    {
      return Err(format!("\"format\" must be png, jpeg or webp, not \"{}\"", short(format)));
    }
    let return_image = opt_bool(map, "returnImage")?;
    if path.is_none() && return_image == Some(false) {
      return Err("returnImage: false without a path would throw the picture away: give a path to write it to.".into());
    }
    let mut params = map.clone();
    params.remove("path");
    params.remove("returnImage");
    if let Some(path) = path {
      require_absolute(path)?;
      let extension = files::extension(path);
      if !files::IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return Err(if extension.is_empty() {
          format!("\"{path}\" has no file extension. A rendered image is written as .png, .jpg, .jpeg or .webp.")
        } else {
          format!("Cannot write a rendered image as .{extension}. Use .png, .jpg, .jpeg or .webp.")
        });
      }
      let from_path = if extension == "jpg" { "jpeg" } else { extension.as_str() };
      if let Some(format) = format
        && format != from_path
      {
        return Err(format!("\"format\" is {format} but the path ends in .{extension}: leave format out or make them agree."));
      }
      params.insert("format".into(), json!(from_path));
    }
    let max_seconds = match map.get("maxSeconds") {
      None | Some(Value::Null) => None,
      Some(value) => match value.as_f64() {
        Some(seconds) if (1.0..=RENDER_MAX_SECONDS).contains(&seconds) => Some(seconds),
        _ => return Err(format!("\"maxSeconds\" must be a number from 1 to {RENDER_MAX_SECONDS}")),
      },
    };
    Ok(Self { path, return_image, params: Value::Object(params), timeout: render_timeout(max_seconds) })
  }
}

async fn render_image<F: Frontend>(frontend: &F, args: &Value) -> Result<Value, String> {
  let RenderArgs { path, return_image, params, timeout } = RenderArgs::parse(args)?;
  let mut rendered = frontend.call("render.image", params, timeout).await?;
  let mut result = json!({ "rendered": true });
  if let Some(path) = path {
    let image = rendered.get("image").ok_or("The editor returned no image from render.image")?;
    let base64 = field(image, "base64", "render.image")?;
    let bytes = files::decode_base64(base64)?;
    files::write_bytes(path, &bytes).await?;
    let inline = return_image.unwrap_or(base64.len() <= RENDER_INLINE_LIMIT);
    result["path"] = json!(path);
    result["bytes"] = json!(bytes.len());
    if !inline && let Some(map) = rendered.as_object_mut() {
      map.remove("image");
      result["image"] = json!("not returned inline (written to path); pass returnImage: true to get it anyway");
    }
  }
  Ok(merged(result, &rendered))
}

const VIDEO_PARAMS: [&str; 15] = [
  "path", "fromFrame", "toFrame", "width", "height", "quality", "format", "bitrate", "samples", "maxSecondsPerFrame",
  "view", "camera", "shading", "hideIds", "documentId",
];
/// How long to wait for a video in viewport quality: the largest one allowed (10 minutes of 4K) at a few frames per second.
const VIDEO_TIMEOUT: Duration = Duration::from_secs(3600);
/// In render quality the editor refuses more than one hour of sampling budget; scene preparation per frame comes on top.
const VIDEO_RENDER_TIMEOUT: Duration = Duration::from_secs(4 * 3600);

struct VideoArgs<'a> {
  path: &'a str,
  /// The arguments for `render.video`: everything but `path`, with `format` set from the path.
  params: Value,
  timeout: Duration,
}

impl<'a> VideoArgs<'a> {
  fn parse(args: &'a Value) -> Result<Self, String> {
    let map = object(args, "render_video", &VIDEO_PARAMS)?;
    let path = req_str(map, "path")?;
    require_absolute(path)?;
    let extension = files::extension(path);
    if !files::VIDEO_EXTENSIONS.contains(&extension.as_str()) {
      return Err(if extension.is_empty() {
        format!("\"{path}\" has no file extension. A video is written as .mp4 or .webm.")
      } else {
        format!("Cannot write a video as .{extension}. Use .mp4 (H.264) or .webm (VP9).")
      });
    }
    if let Some(format) = opt_str(map, "format")? {
      if !files::VIDEO_EXTENSIONS.contains(&format) {
        return Err(format!("\"format\" must be mp4 or webm, not \"{}\"", short(format)));
      }
      if format != extension {
        return Err(format!("\"format\" is {format} but the path ends in .{extension}: leave format out or make them agree."));
      }
    }
    let render = match opt_str(map, "quality")? {
      None | Some("viewport") => false,
      Some("render") => true,
      Some(other) => return Err(format!("\"quality\" must be viewport or render, not \"{}\"", short(other))),
    };
    let mut params = map.clone();
    params.remove("path");
    params.insert("format".into(), json!(extension));
    Ok(Self { path, params: Value::Object(params), timeout: if render { VIDEO_RENDER_TIMEOUT } else { VIDEO_TIMEOUT } })
  }
}

async fn render_video<F: Frontend>(frontend: &F, args: &Value) -> Result<Value, String> {
  let VideoArgs { path, params, timeout } = VideoArgs::parse(args)?;
  let mut exported = frontend.call("render.video", params, timeout).await?;
  let video = exported.get("video").ok_or("The editor returned no video from render.video")?;
  let bytes = files::decode_base64(field(video, "base64", "render.video")?)?;
  if bytes.is_empty() {
    return Err("The editor returned an empty video from render.video".into());
  }
  files::write_bytes(path, &bytes).await?;
  // The file is on disk; the answer carries the numbers only.
  if let Some(map) = exported.as_object_mut() {
    map.remove("video");
    map.remove("bytes");
  }
  Ok(merged(json!({ "exported": true, "path": path, "bytes": bytes.len() }), &exported))
}

#[cfg(test)]
#[path = "tools_tests.rs"]
mod tests;
