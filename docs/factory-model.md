# Factory models (sidecar format, schema_version 1)

A **factory model** is a Tessel document of the format `minecraft_factory`. It is a normal Minecraft Java
block/item model (everything a `minecraft_java` document can do works the same) plus a **machine definition**
for a server plugin: where items, fluids, energy… go in and out, how big the machine is, and which ways it may
be placed.

Exporting it (File › Export › Minecraft model, or the MCP tool `file_export` with a `.json` path) writes two files
side by side:

| File | For | Content |
| --- | --- | --- |
| `<name>.json` | resource pack (`assets/<ns>/models/...`) | the plain Java block model |
| `<name>.factory.json` | the server plugin | the machine definition described here |

The JSON Schema is [`schemas/factory-model.schema.json`](schemas/factory-model.schema.json). Golden examples:
`src/core/minecraft/factory/golden/*.factory.json`.

## Coordinates

* Units are **model pixels**: 16 pixels per block. The block the plugin places (the *placed block*, the one
  the model is shown on) spans `0..16` on every axis. +X is east, +Y up, +Z south (Minecraft's axes).
* Multi-block machines extend that grid: the block above the placed block spans `y = 16..32`, the block to the
  west `x = -16..0`, and so on. A `block` value is a cell offset from the placed block: `[0, 1, 0]` is the
  block above it. World block of a port = placed block position + `block`.
* Everything at the top level is **authored facing north**. The plugin should not do any geometry itself:
  the `facings` table already contains every port turned for every allowed facing.

## Top level

```jsonc
{
  "schema_version": 1,          // refuse anything you do not know
  "generator": "Tessel",
  "machine":   { ... },
  "footprint": { ... },
  "rotation":  { ... },
  "ports":     [ ... ],         // authored, facing north
  "facings":   { "north": { ... }, "east": { ... } }   // one per allowed facing
}
```

### `machine`

| Key | Type | Meaning |
| --- | --- | --- |
| `id` | string | Namespaced machine id, e.g. `factory:crusher` (`[a-z0-9_.-]+:[a-z0-9_./-]+`). |
| `display_name` | string | Human-readable name; may be empty. |
| `model` | string | Model file name without `.json` (the file next to this one). |
| `properties` | object | Free-form key → string / number / boolean, for whatever the plugin needs (tier, recipe type, speed…). |

### `footprint`

| Key | Type | Meaning |
| --- | --- | --- |
| `size` | `[x, y, z]` ints 1..16 | Size in blocks. `[1, 1, 1]` = a single block. |
| `anchor` | `[x, y, z]` ints | Which cell of the footprint is the placed block, counted from the footprint's lowest corner. |
| `min`, `max` | `[x, y, z]` ints | Inclusive cell range relative to the placed block (`min = -anchor`, `max = size - anchor - 1`), authored facing north. |

A 3 × 1 × 1 machine whose placed block is in the middle has `anchor [1, 0, 0]`, `min [-1, 0, 0]`, `max [1, 0, 0]`.

### `rotation`

| Key | Meaning |
| --- | --- |
| `authored_facing` | Always `"north"`: the model's front points north (−Z), like furnaces and observers. |
| `default_facing` | The facing to use when the plugin has no better idea. Always one of `allowed_facings`. |
| `allowed_facings` | The facings the machine may be placed with, in the order north, east, south, west, up, down. |
| `pivot` | `[8, 8, 8]`: the centre of the placed block, which every rotation turns about. |

### `ports[]`

A port is a connection point: where a conveyor, pipe, cable… attaches and what flows through it.

| Key | Type | Meaning |
| --- | --- | --- |
| `id` | string | Unique within the machine (`[a-z0-9_][a-z0-9_.-]{0,63}`). What the plugin looks ports up by. |
| `name` | string | Display label; may be empty. |
| `kind` | `"input"` \| `"output"` \| `"bidirectional"` | Flow direction seen from the machine. |
| `resource` | id | What flows. Built-in names: `item`, `fluid`, `energy`, `gas`, `heat`, `redstone`, `data`, `any`. Anything else is a custom id, preferably namespaced (`mymod:steam`). |
| `connector` | id | What attaches. Built-in names: `conveyor`, `pipe`, `cable`, `shaft`, `chute`, `direct`, `any`; custom ids allowed. |
| `face` | face | The block face the port opens to, i.e. its outward direction. |
| `direction` | `[x, y, z]` | Unit vector of `face` (`north = [0, 0, -1]`, `east = [1, 0, 0]`, `up = [0, 1, 0]`, …). |
| `position` | `[x, y, z]` | Centre of the opening in pixels, on the pixel grid. Usually on the footprint's outer side it faces (e.g. `x = 16` for an east port of a single block). |
| `block` | `[x, y, z]` | The footprint cell the port belongs to, relative to the placed block. A port on a boundary belongs to the block it opens out of. |
| `size` | `[w, h]` | Width and height of the opening in pixels, on the face plane (informational, e.g. for hit boxes or rendering). |
| `capacity` | number \| null | Buffer size; unit is up to the plugin. |
| `rate` | number \| null | Throughput per tick; unit is up to the plugin. |
| `tags` | id[] | Free tags (`fast`, `mymod:hot`). |
| `properties` | object | Free-form key → string / number / boolean. |

The neighbour block a port connects to is `placed block + block + direction`.

### `facings`

One entry per allowed facing; the key is the facing. Each entry:

| Key | Meaning |
| --- | --- |
| `blockstate` | `{ "x": 0|90|180|270, "y": 0|90|180|270 }`: the blockstate variant rotation that shows the model facing this way. Use it for the blockstate JSON of the resource pack. |
| `matrix` | Rows of the integer rotation matrix `M` (see below). |
| `footprint` | `{ min, max }`: the cells the placed machine covers, relative to the placed block. |
| `ports` | Index-aligned with the top-level `ports`: `{ id, face, direction, position, block }` after turning. Everything else (kind, resource…) does not change with the facing. |

So, for a machine placed at block `P` facing `F`: for each `p` in `facings[F].ports`, the port is in world block
`P + p.block`, opens towards `p.face`, and connects to the block `P + p.block + p.direction`.

## How rotation works

The plugin does not need this (the table has the results), but here is the exact rule so it can be reproduced:

| Facing | blockstate | Meaning |
| --- | --- | --- |
| north | x 0, y 0 | as authored |
| east | x 0, y 90 | turned clockwise seen from above |
| south | x 0, y 180 | |
| west | x 0, y 270 | |
| up | x 270, y 0 | front tipped up; what was on top now faces south |
| down | x 90, y 0 | front tipped down; what was on top now faces north |

This is the same rotation Minecraft applies to a blockstate variant: first about X, then about Y, about the
centre of the block. With `Y90 = [[0,0,-1],[0,1,0],[1,0,0]]` (north → east) and
`X90 = [[1,0,0],[0,0,1],[0,-1,0]]` (north → down), `M = Y90^(y/90) · X90^(x/90)` and

* point: `p' = M (p − [8, 8, 8]) + [8, 8, 8]`
* face: the face of `M · direction`
* block: the cell containing `M (centre(block) − [8, 8, 8]) + [8, 8, 8]`, where `centre(block) = block · 16 + 8`.

The resource pack blockstate for a machine with the four horizontal facings is then simply:

```json
{
  "variants": {
    "facing=north": { "model": "factory:block/crusher" },
    "facing=east":  { "model": "factory:block/crusher", "y": 90 },
    "facing=south": { "model": "factory:block/crusher", "y": 180 },
    "facing=west":  { "model": "factory:block/crusher", "y": 270 }
  }
}
```

## Example

A one-block machine with an item input on the west and an output on the east (the "Machine" template):

```json
{
  "schema_version": 1,
  "generator": "Tessel",
  "machine": { "id": "factory:crusher", "display_name": "Crusher", "model": "crusher", "properties": {} },
  "footprint": { "size": [1, 1, 1], "anchor": [0, 0, 0], "min": [0, 0, 0], "max": [0, 0, 0] },
  "rotation": { "authored_facing": "north", "default_facing": "north", "allowed_facings": ["north", "east", "south", "west"], "pivot": [8, 8, 8] },
  "ports": [
    { "id": "input", "name": "Input", "kind": "input", "resource": "item", "connector": "conveyor",
      "face": "west", "direction": [-1, 0, 0], "position": [0, 8, 8], "block": [0, 0, 0],
      "size": [6, 6], "capacity": null, "rate": null, "tags": [], "properties": {} }
  ],
  "facings": {
    "east": {
      "blockstate": { "x": 0, "y": 90 },
      "matrix": [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
      "footprint": { "min": [0, 0, 0], "max": [0, 0, 0] },
      "ports": [ { "id": "input", "face": "north", "direction": [0, 0, -1], "position": [8, 8, 0], "block": [0, 0, 0] } ]
    }
  }
}
```

(`facings` shortened to one entry; real files list every allowed facing.)

## Compatibility rules

* `schema_version` changes only when a reader written for the old version would **misread** a new file.
  Readers must refuse a version they do not know.
* New keys may be added within a version. Readers must ignore keys they do not know.
* All listed keys are always written; optional values are `null`, empty strings, `[]` or `{}`, never missing.
* A file Tessel writes may still fail validation (e.g. a port without a face, duplicate ids) if the user
  exported anyway; Tessel shows these problems in the Factory panel and through `factory_validate`.
  Plugins should reject such machines with a clear message.

## Editing in Tessel

* File › New › Factory Model, optionally from a template (Machine, Conveyor segment, Pipe junction).
* Ports are listed in the outliner and drawn in the viewport (blue = input, orange = output,
  green = bidirectional; the arrow points the way things flow). Edit them in the Properties panel.
* MCP tools: `factory_get`, `factory_set_machine`, `factory_add_port`, `factory_update_port`,
  `factory_remove_ports`, `factory_duplicate_port`, `factory_reorder_port`, `factory_place` (turned ports for
  one facing), `factory_validate`, `factory_export_sidecar`, `document_import_factory`; `file_open` on a model
  with a sidecar next to it (or on the sidecar) opens the factory document again.
* The `.tessel` project file stores the machine too; the sidecar is an export format, the project file is the
  source of truth.
