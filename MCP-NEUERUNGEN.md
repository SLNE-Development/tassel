# Tessel 0.2.0 – Neuerungen am MCP-Server

Antwort auf `Tessel-MCP-Feedback.md`. Zum Weitergeben an eine Session, die über MCP mit Tessel arbeitet.
Konventionen wie bisher: Y ist oben, Meter, Euler XYZ in Grad. Der Server bietet jetzt 150+ Tools.

## Das Wichtigste zuerst: so baut man jetzt schnell

1. Befehle per Script als JSON-Datei erzeugen (Array von `{ "tool", "params", "as"? }`).
2. Einmal prüfen: `batch { "file": "C:\\work\\build.json", "validateOnly": true }`
3. Ausführen: `batch { "file": "C:\\work\\build.json", "documentId": "<id>", "resultMode": "summary" }`
4. IDs nie abschreiben: Label mit `as` vergeben und mit `$label` referenzieren, oder Objekte, Gruppen und
   Materialien über ihren Namen ansprechen.
5. Eigenes Dokument im Hintergrund anlegen (`document_new { "name": "Baum", "activate": false }`) und dessen `id`
   bei JEDEM Aufruf als `documentId` mitgeben. Der Nutzer kann dann beliebig Tabs wechseln.

## Überall gültig

- **`documentId`** (optional, an jedem Tool): Aufruf wirkt auf dieses offene Dokument, ohne den sichtbaren Tab zu
  wechseln. Ohne `documentId` wirkt er auf den Tab, der in diesem Moment sichtbar ist. Screenshots, Renders und
  Kamera-Befehle funktionieren auch für Hintergrund-Dokumente. Nur `view_set_tool` und `view_set_shading` lehnen
  ein Hintergrund-Dokument ab (für Bilder gibt es die Option `shading`).
- **Namen statt IDs**: wo eine Objekt-, Gruppen- oder Material-ID erwartet wird, geht auch der exakte Name oder ein
  Muster mit `*` und `?` (z. B. `"Belt *"`). Einzel-Parameter müssen genau einen Treffer haben, Listen nehmen alle.

## Batch

```
batch { commands? | file?, resultMode?: "full"|"ids"|"summary", continueOnError?, validateOnly?, documentId? }
Command = { tool, params?, as? }
```
- `file`: absoluter Pfad zu einer `.json` (Array oder `{ "commands": [...] }`), max. 16 MB, max. 20.000 Befehle.
- Referenzen in `params` (auch verschachtelt, nur als ganzer String): `"$label"` → `id` des Ergebnisses,
  `"$label.pfad.0.feld"` → Feld, `"$3"` → Ergebnis von Befehl 3 (0-basiert), `"$prev"` → vorheriger Befehl.
  Ein echtes `$` am Anfang schreibt man `$$`.
- `resultMode`: `full` (Standard bei `commands`), `ids` (Standard bei `file`; nur identifizierende Felder),
  `summary` (Zähler, Fehler, Label→ID, letzter Screenshot).
- Jedes Ergebnis enthält `labels`, `objectCount`, `document { id, name }`. Ein Batch mit Fehlern kommt als
  MCP-Fehler zurück, die erfolgreichen Befehle stehen trotzdem drin.

```json
{ "commands": [
  { "tool": "material_create", "params": { "name": "Stahl", "metallic": 1, "roughness": 0.35 }, "as": "steel" },
  { "tool": "group_create", "params": { "ids": [], "name": "Band" }, "as": "g" },
  { "tool": "scene_add_primitive", "params": { "type": "cube", "dimensions": [4, 0.1, 1], "position": [0, 0.8, 0],
      "groupId": "$g", "materialId": "$steel" }, "as": "belt" },
  { "tool": "modifier_add", "params": { "objectId": "$belt", "type": "array", "count": 3, "offset": [0, 0, 1.5], "offsetSpace": "world" } },
  { "tool": "view_screenshot", "params": { "views": ["front", "top", "iso"] } }
] }
```

## Dokumente

| Tool | Beispiel |
|---|---|
| `document_new { name?, activate = true }` → `{ id, name, active }` | `{ "name": "Baum", "activate": false }` |
| `file_open { path, activate = true }` | `{ "path": "C:\\m\\baum.tessel", "activate": false }` |
| `file_save { path?, documentId? }` → `{ saved, path, name, objectCount, renamedFrom? }` | `{ "path": "C:\\m\\baum.tessel", "documentId": "<id>" }` |
| `file_export { path, selectionOnly?, documentId? }` → `files` mit vollen Pfaden | `{ "path": "C:\\m\\baum.glb" }` |
| `app_get_state { documentId? }` → Arbeitsdokument, `visibleDocumentId`, alle Dokumente mit `objectCount` | `{ "documentId": "<id>" }` |
| `app_validate_commands { commands: [{ command, params? }] }` | meist über `batch { validateOnly }` |

## Modelle platzieren, Objekte als Einheit bewegen

| Tool | Beispiel |
|---|---|
| `scene_place_model { path, position?, rotation?, scale?, groupId?, name?, reuseMaterials = true }` – setzt `.tessel .glb .gltf .obj .stl .ply .fbx` als EINE Gruppe; gleiche Materialien werden wiederverwendet | `{ "path": "C:\\m\\presse.tessel", "position": [10, 0, 5], "rotation": [0, 90, 0], "name": "Presse 1" }` |
| `scene_transform_objects { ids?, groupId?, translate?, rotate?, scale?, pivot? }` – RELATIV, Weltkoordinaten, Reihenfolge Skalieren → Drehen → Verschieben; Pivot-Standard: Mitte der Bounding-Box | `{ "groupId": "Presse 1", "rotate": [0, 90, 0], "translate": [0, 0, 5] }` |
| `scene_mirror_objects { ids?, axis, pivot = [0,0,0], duplicate = true, groupId? }` | `{ "ids": ["Rad L"], "axis": "x" }` |
| `scene_apply_transform { ids?, position = false, rotation = true, scale = true }` | `{ "ids": ["Wand*"] }` |
| `material_import { path, names? }` – Materialien aus anderer `.tessel` | `{ "path": "C:\\m\\lib.tessel", "names": ["Stahl", "Lack *"] }` |
| `material_replace { from, to, ids? }` | `{ "from": "Stahl", "to": "Gummi" }` |

## Geometrie in einem Aufruf

| Tool | Beispiel |
|---|---|
| `scene_add_primitive` – Würfel mit `dimensions: [x,y,z]`; neuer Typ `arc` (`innerRadius, outerRadius, height, angle, startAngle, segments`; 0° = +X, steigend Richtung −Z) | `{ "type": "arc", "innerRadius": 2, "outerRadius": 3, "height": 0.1, "angle": 90, "segments": 12 }` |
| `scene_add_tube { points, radius \| radii, segments = 12, closed?, caps?, smooth? }` – Rohr/Strebe/Kabel entlang Weltpunkten | `{ "points": [[2.5, 0, 2], [3.1, 1.1, 4]], "radius": 0.04 }` |
| `scene_add_text { text, size = 1, depth = 0.1, font = "default", bold?, italic?, align?, position?, … }` – jede installierte Schrift; `font_list { search? }` zeigt sie | `{ "text": "Linie 4", "font": "Segoe UI", "bold": true, "size": 0.3, "depth": 0.03 }` |
| `scene_add_mesh { positions, faces, uvs?, position?, … }` → mit `warnings` (offene Kanten, verdrehte Flächen) | `{ "positions": [[0,0,0],[1,0,0],[0,1,0],[0,0,1]], "faces": [[0,2,1],[0,1,3],[1,2,3],[0,3,2]] }` |
| `scene_boolean { objectId?, operation = "difference", targetId? \| cutter?, apply = true, keepTarget? }` | `{ "objectId": "Platte", "cutter": { "type": "cylinder", "radius": 0.1, "height": 1, "position": [0.5, 0, 0.2] } }` |
| Array-Modifier: `rotation` (pro Kopie), `pivot` (lokal), `offsetSpace: "local"\|"world"` | radial: `{ "type": "array", "count": 12, "offset": [0,0,0], "rotation": [0,30,0], "pivot": [-1,0,0] }` |

Array-Versatz: `local` = lokale Einheiten vor der Objekt-Skalierung; `world` = Weltmeter entlang der Weltachsen zum
Zeitpunkt des Setzens, danach dreht und skaliert der Versatz starr mit dem Objekt mit.

## Abfragen

| Tool | Beispiel |
|---|---|
| `scene_list_objects { name?, groupId?, materialId?, visible?, offset = 0, limit = 500, includeBounds? }` → `{ total, objects, selection }` | `{ "groupId": "Presse 1", "name": "Bein*", "includeBounds": true }` |
| `scene_select_by { name?, materialId?, groupId?, mode? }` (alles abwählen: `scene_select { "ids": [] }`) | `{ "materialId": "Stahl" }` |
| `scene_get_bounds { ids?, groupId? }` → Welt-Bounding-Box je Objekt und gesamt | `{ "groupId": "Presse 1" }` |
| `scene_check_overlaps { ids?, groupId?, tolerance = 0 }` – Bounding-Box-Test, keine exakte Durchdringung | `{ "tolerance": 0.001 }` |
| `scene_raycast { origin, direction, maxDistance?, ids? }` → Punkt, Normale, Objekt | `{ "origin": [2, 50, 3], "direction": [0, -1, 0] }` |

Ergebnisse sind ausführlicher: `scene_add_primitive` liefert `transform` und `bounds`, `modifier_*` und `edit_exit`
die `objectId`, Mesh-Operationen `selectionBounds` (lokal), Gruppenbefehle die resultierende Hierarchie.
`mesh_select_by` arbeitet im LOKALEN Raum des Objekts.

## Bilder

```
view_screenshot { width, height, view?, camera?: { position, target, fov? }, views?: [...], fit?: true | [ids],
                  hideIds?, onlyIds?, shading?, xray?, frame?, useAnimationCamera?, documentId? }
```
- Presets: `front` = Kamera auf +Z, Blick nach −Z; `right` = von +X; `top` = von +Y; `iso` = von (+X,+Y,+Z).
- `camera` und Presets bewegen die Kamera des Nutzers nicht. `views` legt bis zu 9 Ansichten beschriftet in ein Bild.
- Das Ergebnis nennt je Ansicht Kameraposition, Ziel und Blickrichtung.

Beispiele: `{ "views": ["front","right","top","iso"], "width": 1600, "height": 1200 }`,
`{ "view": "iso", "hideIds": ["Trichter*"], "fit": ["Walze *"], "shading": "material" }`,
`{ "camera": { "position": [0.4, 1.2, 0.3], "target": [0, 0.8, 0] }, "xray": true }`

**Rendern (Pathtracing, für Präsentationsbilder):**
```
render_image { path?, returnImage?, width?, height?, samples?, maxSeconds?, view? | camera?, fit?, hideIds?, frame?,
               environment?, sun?, background?, ground?, depthOfField?, output?, documentId? }
render_set_settings { environment?, sun?, background?, ground?, camera?, depthOfField?, output?, reset? }
```
`{ "path": "C:\\Renders\\fabrik.png", "view": "iso", "width": 1920, "height": 1080, "samples": 256, "maxSeconds": 120 }`
Der allererste Render auf einem Rechner kompiliert 1–2 Minuten lang einen Shader. Für schnelle Kontrollen weiter
`view_screenshot` nehmen.

## Animation und Video

Frames sind ganze Zahlen ab 0, Zeit = Frame / fps.

| Tool | Beispiel |
|---|---|
| `anim_set_range { fps?, frameCount? }` | `{ "fps": 24, "frameCount": 216 }` |
| `anim_follow_path { ids?, groupId?, points, fromFrame, toFrame, orient?, closed?, anchor? }` | `{ "ids": ["Kiste"], "points": [[-4,0.9,0],[0,0.9,0]], "fromFrame": 0, "toFrame": 72, "anchor": "bottom" }` |
| `anim_add_motion { ids?, groupId?, fromFrame, toFrame, translate?, rotate?, scale?, pivot?, interpolation? }` – bewegt als Einheit, wie `scene_transform_objects` | `{ "groupId": "Roboterarm", "fromFrame": 72, "toFrame": 120, "rotate": [0,90,0], "pivot": [2,0,-3] }` |
| `anim_set_key { ids?, groupId?, frame, position?, rotation?, scale?, visible?, interpolation? }` | `{ "ids": ["Kiste"], "frame": 48, "visible": false }` |
| `anim_camera_orbit { target, radius, height, fromFrame, toFrame, startAngle?, turns?, fov? }`, `anim_set_camera_key { frame, position, target, fov? }` | `{ "target": [0,1,0], "radius": 9, "height": 4, "fromFrame": 0, "toFrame": 215 }` |
| `anim_evaluate { frame \| [frames], ids?, groupId? }` – Posen und Kamera zu Frames, zum Prüfen ohne Video | `{ "frame": [0, 36, 72], "ids": ["Kiste"] }` |
| `anim_get`, `anim_delete_key`, `anim_clear`, `anim_shift_keys`, `anim_delete_camera_key` | |
| `render_video { path (.mp4/.webm), fromFrame?, toFrame?, width = 1280, height = 720, quality: "viewport"\|"render", shading?, view? \| camera?, samples?, maxSecondsPerFrame?, documentId? }` | `{ "path": "C:\\out\\fabrik.mp4", "shading": "material" }` |

Hinweise: `scene_set_transform` und `scene_transform_objects` passen vorhandene Keys NICHT an (Warnung im Ergebnis).
Weiche Interpolation hält an jedem Key kurz an. `quality: "render"` kostet pro Frame so viel wie ein Einzelbild.

## Nicht umgesetzt

- Material pro Fläche und Decals (3.1, 3.5): greift in Datenmodell, Viewport, UV-Editor, Malen und alle Exporter ein.
- Verlinkte Instanzen: `scene_place_model` setzt Kopien.
- Sweep mit freiem Profil, Screw-Modifier: Bogen, Rohr und radiales Array decken die genannten Fälle ab.
- `parentName` / „aktive Gruppe“: durch Batch-Referenzen und Gruppennamen erledigt.
- Quads aus fremden GLBs zurückgewinnen: Tessel-eigene GLBs behalten Polygone und Namen exakt.
