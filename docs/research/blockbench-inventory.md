# Blockbench UI inventory (Java Block/Item, desktop app, 2026-11)
## Start screen
New: General(Generic Model, Image), Minecraft(Java Block/Item, Bedrock Entity, Bedrock Block, Modded Entity, OptiFine Entity, Minecraft Skin, Minecraft Title), Info(Quickstart Wizard, Wiki). Recent grid/list w/ thumbnails + search. Open Model.
Format page: description, Target badge, "Good to know" notes (Java: max 3x3x3 blocks, display can enlarge items; no anims).
## New Project dialog (Java)
Format, File Name, Parent Model, Format Version [1.9-1.21.5 | 1.21.6-1.21.10 | 1.21.11-26.2 | 26.3+], Ambient Occlusion (check), Default UV Mode (Per-face UV / Box UV), UV Size W x H (linked).
## Main window (Java)
Mode tabs top right: Edit | Paint | Display. Toolbar: move-selection?, move, resize, rotate, pivot, vertex snap, ? , "Parent" transform space dropdown, mirror-modeling toggle. Left: UV editor (16x16, size), Textures panel (import, create, folder?). Right: Transform/Element panels, Outliner (+ add cube/group, folder, search, count).
## File menu
Project..., New > (Generic Model, Java Block/Item, Bedrock Entity, Bedrock Block, Bedrock Legacy Model, Modded Entity, OptiFine Entity, OptiFine Part, Minecraft Skin, Image, Minecraft Title; Loaders: Bedrock Player Model), Recent >, Open Model (Ctrl+O), Open Model from Link, New Window, Save Project (Ctrl+Alt+S), Save Project As, Convert Project, Close Project (Ctrl+W), Import > (Import Project, Add Java Block/Item Model, Extruded Texture), Export > (Block/Item Model, glTF, OBJ, FBX, STL, Collada dae, Legacy Project), Save Model (Ctrl+S), Preferences > (Settings, Keybindings, Theme), Plugins..., Edit Session...
- Project dialog Default UV Mode: Per-face UV | Box UV.
## Edit menu
Undo, Redo, Edit History, Add Reference Model, Add Element (...: list of element types; Java: only Cube), Add Group (Ctrl+G), Rename (F2), Find/Replace, Unlock All, Delete, Apply Mirror Modeling, Mirror Modeling (...), Select... (Ctrl+F), Select All, Unselect All, Invert Selection.
## Transform menu
Scale..., Rotate > X/Y/Z +90/-90, Flip > Flip X/Y/Z, Flip in Place X/Y/Z, Center > X/Y/Z/Lateral, Properties > Toggle Visibility/Lock/Export/Auto UV.
## UV menu (also UV editor right-click)
Zoom > (In, Out, Reset), Display UV Faces > (Only selected faces | All faces on selected elements | All faces on all elements), Center View on Selection, UV Editor Checkerboard, Copy, Paste, UV Mode > (Per-face | Box), [ctx: Export UV Mapping], Maximize UV, Auto UV, Relative Auto UV, Move UV to Cursor (Alt+U), Snap UV to Pixels, [ctx: Rotation > 0/90/180/270], Turn Mapping, [ctx: Mirror X, Mirror Y, Tint (checkbox), Cullface >, Texture > (Blank, Transparent, <textures>)].
## UV panel
Face tabs North/East/South/West/Up/Down; size label 16x16; collapse; face-properties toggle opens table per face: Enabled ✓, Texture, Tint (checkbox -> tintindex number field, tooltip: vanilla only specific blocks, usually 0), Cullface (None/N/S/W/E/U/D). UV numeric fields x,y,w,h. Toolbar: Move Texture with UV, Apply To All Faces, Maximize UV, Auto UV, Remove Face, UV Mirror X, UV Mirror Y, UV Rotation slider, Display All Elements toggle. Toolbars have "Customize Toolbar / Reset Toolbar". Panels: Move To (sidebars/float), Attach To, Collapse.
## Tools menu
Toolbox > (Move V, Resize S, Rotate R, Pivot P, Vertex Snap X, Stretch Alt+S, Knife, Seam, Weight Brush | Paint Brush B, Copy Brush, Paint Bucket, Eraser E, Color Picker Alt, Draw Shape U, Gradient, Selection M, Move Layer Shift+V), Swap Tools (Space), Action Control (F = command palette), Edit Predicate Overrides..., Set Cullfaces Automatically, Remove Blank Faces, Generate shape, Generate Player Statue, Creative Tool (T).
Predicate dialog: search; rows [model path e.g. item/custom_model] [+] [predicate type select, e.g. Custom Model Data] [value] [delete]; Add Override, Generate Overrides, Delete All (confirm), Confirm/Cancel.
## View menu
Fullscreen F11, Panels > (Outliner, Transform, Element, Collections, Textures, UV each with Move To...), Toggle Sidebars Ctrl+B, Split Screen > (Single, Double Horizontal, Double Vertical, Quad, Triple Left/Right/Top/Bottom), View Mode > (Textured, Solid, Solid with Marker Colors, Wireframe, UV Preview, Face Orientation), Shading, Show Grids, Ground Plane, Preview Checkerboard (T), Pixel Grid (G), Preview Scene > (None; Generic: Studio; Realistic: Sky, Space; Minecraft: Plains, Snowy Tundra, Cherry Grove, Sunset, Night, Desert, Ocean, Underwater, Coral Reef, Lush Cave, Deep Dark, Nether, ...), Preview Models > (Studio, Minecraft Player, Minecraft Crafting Table), Edit Reference Images, Hide Everything Except Selection (I), Center View on Selection, Screenshot Model (Ctrl+P), Screenshot App, Advanced Screenshot, Record GIF, Timelapse.
## Viewport
Top-right: View-mode menu (same list), Preview Options popover (Background: Checkerboard/Solid/Custom Color; Preview Scene; Shading; Show Grids; Ground Plane; Pixel Grid; Show Element Markers; Show Gizmos), hamburger: Screenshot Model, Add/Paste/Edit Reference Image(s), Preview Scene >, Preview Models >, Center View, Save Angle..., Angles > (Initial, Top, Bottom, South, North, East, West, Isometric Right/Left 2:1, True Isometric Right/Left 30°, Minecraft Title), Orthographic, Split Screen >.
Status bar hints (Ctrl select multiple, Shift range, Alt drag duplicate), FPS.
## Main toolbar (edit)
Move, Resize, Rotate, Pivot, Vertex Snap, Knife?; Transform space dropdown (Global | Parent | Local); Mirror Modeling toggle + popover (Enabled, Mirror UV).
## Transform panel (cube)
Position xyz + "Move Individual Positions" toggle; Size xyz + Inflate; Pivot Point xyz + Center Pivot + "Move Pivot Values Directly"; Rotation xyz (26.3+: free multi-axis, e.g. 30/50 accepted). Group (Java): Pivot Point only.
## Element panel (cube, Java 26.3)
Render Order (Auto/Behind/In Front), Rotation Rescale (checkbox), Shade Direction Override (None/N/S/W/E/U/D; shades every face as if facing that dir), Light Emission (0-15).
## Outliner
Add Element ▾ (Add Cube), Add Group, Toggle More Options (F4: per-row toggles auto-UV?, export, lock, visibility), search, count. Cube right-click: Copy, Paste, Duplicate, Group Elements (Ctrl+Shift+G), Move to >, UV Mode >, Marker Color > (Light Blue, Yellow, Orange, Red, Purple, Blue, Green, Lime, Pink, Silver), Randomize Marker Colors, Texture >, Transparency Render Order > (Auto, Behind, In Front), Rename F2, Toggle Visibility, Delete. Group right-click: + Sort, Resolve Group (no UV/texture).
## Textures panel
Import Texture (Ctrl+T), Create Texture, Load from folder?, (4th icon), search, menu. Create Texture dialog: Name, Folder, Type (Texture Template | Solid Color Template | Blank), Pixel Density (16x...), Color, Rearrange UV, Box UV, Power of 2 Size, Keep Multi-Texture Occupancy, Padding.
Texture right-click: Apply to Face, Apply to Untextured Faces, Apply to Elements, Use/Stop using for Particles, Extrude Texture, Render Mode >, Resize Texture, Flipbook Animation, Create Material, Append Elements to Template, Copy, Duplicate, Edit in Blockbench, Enable Layers, Save As, Change File, Delete, Properties.
Texture Properties: Name, Variable (id, e.g. 0), Folder (e.g. block), Namespace, File Format, Render Mode, Frame Time, Interpolate, Loop Mode. -> link = namespace:folder/name (namespace typed per texture each time = user pain point).
## Display mode (Java)
Menu Display: Copy (Ctrl+C), Paste (Ctrl+V), New Preset, Apply Preset >. Toolbar: Move, Rotate(?), Scale gizmos + toolbar.
Panel top: Copy, Paste, New Preset (dialog: Name + checkbox per slot: Thirdperson R/L, Firstperson R/L, Head, Ground, Embedded, Frame, Shelf, GUI), Apply Preset (searchable list: Default Item, Default Block, Default Weapon, Default Rod, Ground (Armor Stand); each "..." options; custom presets savable). Per-slot extra dropdown at top: GUI -> Side Light | Front Light (gui_light); Shelf -> Top Alignment | Bottom Alignment.
Slots (icons): Thirdperson Right, Thirdperson Left, Firstperson Right, Firstperson Left, Head, Ground, Frame, Shelf, GUI.
Reference models per slot:
- Thirdperson R/L + Head: Player (user's skin!), Zombie, Baby Zombie, Armor Stand, Armor Stand Small; "Pose Angle (For Preview Only)" slider (22.5 default for hands, 0 for head).
- Firstperson R/L: Normal, Charged Bow, Charged Crossbow, Horn Tooting, Eating (screen-frame camera view w/ crosshair).
- Ground: Block, Fox; "Preview Animation" checkbox (rotating/bobbing item).
- Frame: Item Frame, Item Frame (Invisible), Item Frame Top, Item Frame Top (Invisible).
- Shelf: Shelf (All Slots), Shelf (Left/Center/Right Slot).
- GUI: 3x3 (crafting grid), Inventory (full inventory screen), HUD (hotbar with hearts/hunger); orthographic, camera locked "South".
Sliders: Rotation xyz (-180..180) + reset; Translation xyz (-80..80) + reset; Scale xyz + mirror toggle + reset; each with drag-number "<>" field. Live preview updates. Default Block preset on GUI = rot 30/225/0, scale 0.625.
## Paint mode
Menus Image: Adjust Brightness & Contrast, Saturation & Hue, Opacity, Invert Colors, Adjust Curves, Limit to Palette, Split RGBA Channels into Layers, Split Alpha into Layer, Clear Unused Texture Space, Flip H/V, Rotate CW/CCW, Resize Texture, Crop Texture to Selection. Paint: Mirror Painting (...), Erase Mode, Lock Alpha Channel, Painting Grid (G).
Left: 2D texture editor (texture name, zoom %, toggle) + Textures | Layers tabs (Layers: new/import/group; "Enable Layers"). Right: Color (picker, hex, primary/secondary swatches, HSV inputs, add-to-palette, eyedropper; settings: Picker Type, Slider Mode) | Palette (load/save/sort/generate palette...; swatch grid). Outliner (lock/visibility only).
Toolbar tools: Brush ▾ (Pixel Brush, Pixel-perfect Brush, Smooth Brush, Screen Space Brush, Brush Presets...), Copy Brush (mode Copy|Pattern|Sample), Paint Bucket (fill mode Face|Element|Selected Elements|Connected Colors|Colors), Eraser, Color Picker, Draw Shape (Rect, Rect hollow, Ellipse, Ellipse hollow), Gradient, Selection ▾ (Rectangle, Ellipse, Lasso Select, Magic Wand, Same Color), Move Layer. Params: size, opacity (0-255), softness; brush shape square|circle; Blend Mode (Default, Set Opacity, Color, Behind, Multiply, Add, Lighten, Darken, Screen, Overlay, Difference); Mirror Painting popover (Enabled, Global Symmetry, Local Symmetry, Axis X|Z, 2D Editor Symmetry); Erase Mode; Lock Alpha; Painting Grid; Tiled View popover (Mirrored Edges).
## Textures (more)
Texture right-click (paint): + Edit > (all Image-menu ops). Render Mode > Default | Emissive | Additive. Flipbook Editor: frame strip with "Reframe", preview + timeline play/prev/next, frame add/duplicate/delete/(?) buttons, FPS (20), Code Reference (mcmeta), Apply/Cancel.
## Settings
Categories: General, Interface, Preview, Controls, Edit, Paint, Grid, Snapping, Defaults, Dialogs, Application, Export; settings profiles (+), search, Import/Export Settings.
Export: JSON Indentation (Tabs), Final Newline, Minified Export, Export Asset Paths (Relative), Embed Textures, Minified Project Files, Export Empty Groups, Export Groups in Java block/item models, ... Defaults: Cube Size 2, Auto UV, Inherit Parent Color, Rename New Element, Default Minecraft Textures Path (folder with vanilla textures), Default Bedrock Format, Default Java Block/Item Version (Latest). Search found "Allow Display Slot Mirroring".
## Help
Search and Run Action, Quickstart Wizard, Discord, Wiki, Report Issue, View Backups, Developer >, Reset Layout, About.
## Installed plugins (user's)
Minecraft Title Generator, Colour Gradient Generator, MTools (mesh modeling tools), Player Statue Generator (Java/bedrock), Shape Generator (Tools>Generate shape: Hexadecagon|Octagon, Hollow, Variable Diameter/Length|Radius|Side, Value, Height/Depth, Center Point, Axis), Creative Mode (place/remove cubes like MC creative; Tools>Creative Tool T), Reference Models (load glTF/glb/other project tabs as references), Tweaks & Stuff, Explorer (file tree of project folder in sidebar).
User's recent files: arrow_*.json, icon_base.json, cross.json, smash.json -> Java GUI/item icon models (likely resource-pack UI).

---
# Part 2: from the Blockbench source (clone ec0b282, Oct 2026)

## Formats (10) and feature flags
| id | Name | Export |
|---|---|---|
| free | Generic Model | .bbmodel + glTF/OBJ/FBX/STL/DAE |
| image | Image | png/jpg/webp/tga/gif |
| skin | Minecraft Skin | skin png + model |
| java_block | Java Block/Item | .json |
| bedrock / bedrock_block / bedrock_old | Bedrock Entity / Block / Legacy | geometry .json (+ animations .json) |
| modded_entity | Modded Entity | .java (ModelPart/LayerDefinition code + animation class) |
| optifine_entity / optifine_part | OptiFine | .jem / .jpm |
Flags gate the editor: box_uv, optional_box_uv, single_texture, per_texture_uv_size, uv_rotation, animated_textures, texture_mcmeta, texture_folder, select_texture_for_particles, java_face_properties (tint), cullfaces, parent_model_id, vertex_color_ambient_occlusion, bone_rig, centered_grid, rotate_cubes, rotation_limit (<1.21.11: one axis, ±45), rotation_snap (1.9: 22.5° steps), integer_size, meshes, locators, java_cube_shading_properties (shade, light_emission), java_cube_shade_direction_override (26.3+), animation_mode, display_mode (java_block, bedrock_block), cube_size_limiter (java: -16..32). java_block sets 22 flags.
Modes: Edit, Paint, Display, Animate, Pose (skin). Convert Project re-applies flags destructively (clamps rotations, removes meshes, shifts centered grid by 8, etc.).

## Java Block/Item JSON (exporter java_block.ts)
Keys in order: format_version? (Blockbench internal), credit, parent, ambientocclusion:false (only if false), render_type, texture_size [w,h] (only if !=16), textures {id: "namespace:folder/name"; namespace omitted if minecraft; particle}, elements, gui_light:"front" (if set), overrides [{model, predicate}], display {slot: {rotation, translation, scale}} (only non-default), groups (if export_groups).
Element: name (unless "cube"), from/to (inflate applied), shade:false, light_emission, shade_direction_override (26.3+), rotation {origin, axis, angle} (old) or {x,y,z,origin} (1.21.11+ multi-axis / >45°), rescale, faces {dir: {uv (scaled to 16), rotation, texture "#id" or "#missing", cullface, tintindex}}. Faces with texture null are omitted; elements with no faces dropped.
Versions offered: 1.9–1.21.5 | 1.21.6–1.21.10 | 1.21.11–26.2 | 26.3+. 1.21.6+: GUI preview clipped to 16x16 slot.
Import: resolves parent chain (up to 32), item/generated & handheld -> "generated item mesh" from layer0..4; keeps unknown root keys.
Predicate editor (legacy overrides): custom_model_data, damage, damaged, lefthanded, angle, time, blocking, broken, cast, cooldown, pull, pulling, charged, firework, throwing, level, filled, tooting; "Generate Overrides" makes N variants. NO support for 1.21.4+ items/*.json item model definitions (select/range_dispatch/condition) — gap.
Validator: texture names must match [a-z0-9._/-]; zero-width UV faces; cube size limit; generated-item + elements conflict.

## Display slots
thirdperson_righthand/lefthand, firstperson_righthand/lefthand, head, ground, gui, fixed, on_shelf (Java), embedded (Bedrock only). Clamp: rotation ±180, translation ±80, scale 0..4. Left-hand preview mirrors right. Presets item/block/handheld/rod/armor_stand + custom (localStorage). Reference scenes are hard-coded cube models (display_references.ts).

## Elements, UV, textures
Cube: from,to,origin,rotation,inflate,stretch,box_uv,mirror_uv,uv_offset,autouv(0 off/1 auto/2 relative),shade,light_emission,render_order,color(marker),visibility,locked,export; faces {uv[4],rotation 0/90/180/270,tint,cullface,texture,enabled}.
Group: origin, rotation (not in Java), export, locked, visibility, shade, autouv; Java groups have only pivot.
Snapping: grid 1px (16/16), Shift 1/4px, Ctrl 1/10px, Ctrl+Shift 1/40px; rotation 2.5°, Shift 22.5°, Ctrl 1°.
Texture props: name, folder, namespace, id/variable, particle, render_mode (default/emissive/additive/layered), render_sides, wrap_mode, pbr_channel, fps, frame_time, frame_order(_type), frame_interpolate, uv size. Link = namespace:folder/name. Create Texture: template (auto-packs UV), solid color template, blank; pixel density 16–512.
Paint engine: layers with blend modes, selection, image adjustments, palettes, mirror painting, pixel-perfect.

## Animation (not used by Java Block/Item)
Bedrock-style: animations (loop once/loop/hold, length, snapping, blend weight, Molang), per-bone rotation/position/scale keyframes (linear, catmullrom, bezier, step), effects (sound, particle, timeline), IK (FABRIK), controllers, graph editor, onion skin, motion trails. Export: Bedrock animation JSON 1.8.0, Java animation class (modded entity). .bbmodel stores everything (elements, outliner, textures embedded, animations) and is what ModelEngine/BetterModel read (from their docs; not in Blockbench code).
