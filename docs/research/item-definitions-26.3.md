# Item model definitions (`assets/<ns>/items/<id>.json`) for Java 26.3

Research notes behind `src/core/minecraft/items/`. Tessel's item definition editor targets 26.3+.

## Sources

1. **The 26.3 client jar itself** (local launcher install, `versions/26.3` / `fabric-loader-0.20.1-26.3`, `version.json` id `26.3`).
   Since 26.1 the client ships unobfuscated, so the codec classes can be read with `javap -c -p`: registry ids
   (`ItemModels`, `ConditionalItemModelProperties`, `RangeSelectItemModelProperties`, `SelectItemModelProperties`,
   `SpecialModelRenderers`, `ItemTintSources`), field names (`fieldOf` / `optionalFieldOf` string constants) and
   defaults (the constant pushed before `optionalFieldOf(name, default)`).
2. **The 1 658 vanilla item definitions in that jar** (`assets/minecraft/items/*.json`) for real usage, key order and
   value sets (trim materials, display contexts, copper golem poses, ...).
3. The **26.2** and **26.4-snapshot-6** jars, dumped the same way and diffed against 26.3 to find version boundaries.
4. Background only: the public Minecraft Wiki page "Items model definition" (1.21.4 era). Where it disagrees with the
   jar, the jar wins. No Blockbench code or data was used.

Nothing from the jar is bundled: Tessel only knows ids, field names and defaults (facts), and reads models and
textures at run time from the user's own jar through `src/mcassets`.

## Version findings

| Change | Versions |
| --- | --- |
| `minecraft:map_color` tint source | exists in 26.2, **removed in 26.3** (`filled_map` has no tint any more) |
| everything else listed below | identical in 26.2, 26.3 and 26.4-snapshot-6 |

The registry in `src/core/minecraft/items/registry.ts` starts at 26.3 (Tessel's oldest target), so `map_color` is not
offered; if read from a file it is kept verbatim and reported as unknown for the target version.

## File

```json
{ "model": <item model>, "hand_animation_on_swap": true, "oversized_in_gui": false, "swap_animation_scale": 1.0 }
```
`ClientItem$Properties`: `hand_animation_on_swap` bool (default true), `oversized_in_gui` bool (default false),
`swap_animation_scale` float (default 1.0; spears use 1.95). Vanilla writes `"type"` first, then keys alphabetically.

## Item model types (`ItemModels`)

Every type also takes an optional `transformation` (`com.mojang.math.Transformation.EXTENDED_CODEC`: a 16-float
matrix or `{translation, left_rotation, scale, right_rotation}`, rotations as quaternion `[x,y,z,w]` or
`{angle, axis}`). Vanilla uses it on beds, banners, heads, shulker boxes, tridents.

| type | fields |
| --- | --- |
| `minecraft:model` | `model` (model id, required), `tints` (list of tint sources, optional) |
| `minecraft:composite` | `models` (list of item models) |
| `minecraft:condition` | `property` + its fields, `on_true`, `on_false` |
| `minecraft:select` | `property` + its fields, `cases` [`{when: value or [values], model}`], `fallback` (optional) |
| `minecraft:range_dispatch` | `property` + its fields, `scale` (float, default 1), `entries` [`{threshold, model}`], `fallback` (optional) |
| `minecraft:special` | `base` (model id for particles / display transforms), `model` (special model, see below) |
| `minecraft:empty` | — |
| `minecraft:bundle/selected_item` | — |

`range_dispatch` picks the entry with the highest threshold <= value * scale, else the fallback.

## Condition properties (`on_true` / `on_false`)

`broken`, `bundle/has_selected_item`, `carried`, `component` (`predicate`: data component predicate id, `value`),
`custom_model_data` (`index` int >= 0, default 0: the flags list), `damaged`, `extended_view`, `fishing_rod/cast`,
`has_component` (`component`, `ignore_default` default false), `keybind_down` (`keybind`, e.g. `key.use`),
`selected`, `using_item`, `view_entity`.

## Select properties (`cases[].when`)

`block_state` (`block_state_property`; values are strings), `charge_type` (`none`/`rocket`/`arrow`),
`component` (`component`; value in that component's format), `context_dimension` (dimension ids),
`context_entity_type` (entity type ids), `custom_model_data` (`index`, default 0: the strings list),
`display_context` (`none`, `thirdperson_lefthand`, `thirdperson_righthand`, `firstperson_lefthand`,
`firstperson_righthand`, `head`, `gui`, `ground`, `fixed`, `on_shelf`), `local_time` (`pattern` required, `locale`
default "", `time_zone` optional), `main_hand` (`left`/`right`), `trim_material` (trim material ids: amethyst, copper,
diamond, emerald, gold, iron, lapis, netherite, quartz, redstone, resin).

## Numeric properties (`range_dispatch`)

`bundle/fullness`, `compass` (`target` none/spawn/lodestone/recovery, `wobble` default true), `cooldown`,
`count` (`normalize` default true), `crossbow/pull`, `custom_model_data` (`index` default 0: the floats list),
`damage` (`normalize` default true), `time` (`source` daytime/moon_phase/random, `wobble` default true),
`use_cycle` (`period` > 0, default 1), `use_duration` (`remaining` default false).

## Tint sources (`minecraft:model` → `tints`)

`constant` (`value`), `custom_model_data` (`index` default 0, `default`), `dye` (`default`), `firework`
(`default`), `grass` (`temperature`, `downfall`), `potion` (`default`), `team` (`default`). Colours use
`RGB_COLOR_CODEC`: an int (vanilla writes opaque ARGB, e.g. `-6265536`) or `[r, g, b]` floats 0..1.

## Special models (`minecraft:special` → `model`)

`banner` (`color` dye colour, `attachment` ground/wall default ground), `bell`, `book` (`open_angle`, `page1`,
`page2` floats), `chest` (`texture` id, `openness` default 0, `chest_type` single/left/right default single),
`conduit`, `copper_golem_statue` (`texture`, `pose` standing/running/sitting/star), `decorated_pot`,
`end_cube` (`effect` portal/gateway), `head` (`kind` skeleton/wither_skeleton/player/zombie/creeper/piglin/dragon,
`texture` optional, `animation` default 0), `player_head`, `shield`, `shulker_box` (`texture` default
`minecraft:shulker`, `openness` default 0), `trident`.
