import type { PreviewScene } from '../../core/preview';
import type { BlockName } from './blocks';

// What each preview scene looks like: sky, fog, lights and (Minecraft scenes) a small block landscape.
// Everything here is plain data and deterministic generation, so it can be tested without a renderer.

export interface SkyLook {
  /** Colours at the zenith, the horizon and straight down. */
  top: string;
  horizon: string;
  bottom: string;
  /** A square sun or moon: direction in degrees, size in degrees of arc. */
  sun?: { azimuth: number; elevation: number; color: string; size: number; glow?: string };
  stars?: number;
}

export interface SceneLook {
  sky: SkyLook;
  /** Distances in blocks from the point the camera orbits, on top of the camera distance. */
  fog?: { color: string; near: number; far: number };
  ambient: { sky: string; ground: string; intensity: number };
  key: { color: string; intensity: number };
  fill: { color: string; intensity: number };
  /** Brightness of the block landscape (Minecraft's light level, 0..1). */
  terrainLight: number;
  terrain: TerrainKind | null;
  /** Colour of the optional ground plane in scenes without terrain. */
  ground: string;
}

export type TerrainKind = 'plains' | 'snowy' | 'cherry' | 'desert' | 'ocean' | 'underwater' | 'lush_cave' | 'deep_dark' | 'nether';

/** The editor's own lights (see `Stage`), which scene "none" keeps. */
export const DEFAULT_LIGHTS = {
  ambient: { sky: '#e4e9f2', ground: '#3a3632', intensity: 1.5 },
  key: { color: '#fff3e4', intensity: 2.4 },
  fill: { color: '#a9bfe6', intensity: 0.7 },
};

const day = {
  ambient: { sky: '#dbe8ff', ground: '#5a5040', intensity: 1.4 },
  key: { color: '#fff6e8', intensity: 2.6 },
  fill: { color: '#b4c8ee', intensity: 0.6 },
};

const daySky: SkyLook = { top: '#78a7ff', horizon: '#c0d8ff', bottom: '#8aa0b8', sun: { azimuth: -40, elevation: 50, color: '#fffbe0', size: 6, glow: '#fff3b0' } };

export const sceneLooks: Record<Exclude<PreviewScene, 'none'>, SceneLook> = {
  studio: {
    sky: { top: '#5b6168', horizon: '#9aa0a6', bottom: '#3d4146' },
    ambient: { sky: '#f2f2f2', ground: '#4a4a4a', intensity: 1.6 },
    key: { color: '#ffffff', intensity: 2.6 },
    fill: { color: '#d8e0ec', intensity: 0.9 },
    terrainLight: 1,
    terrain: null,
    ground: '#8c9096',
  },
  sky: {
    sky: daySky,
    fog: { color: '#c0d8ff', near: 40, far: 140 },
    ...day,
    terrainLight: 1,
    terrain: null,
    ground: '#7fa05e',
  },
  space: {
    sky: { top: '#05060d', horizon: '#141433', bottom: '#020205', stars: 1400, sun: { azimuth: 120, elevation: 12, color: '#fff4dc', size: 3, glow: '#ffe7a8' } },
    ambient: { sky: '#7a86b8', ground: '#120f1a', intensity: 0.7 },
    key: { color: '#fff1dc', intensity: 3.2 },
    fill: { color: '#4b5aa8', intensity: 0.35 },
    terrainLight: 1,
    terrain: null,
    ground: '#2a2a35',
  },
  plains: { sky: daySky, fog: { color: '#c0d8ff', near: 24, far: 52 }, ...day, terrainLight: 1, terrain: 'plains', ground: '#6fa64a' },
  snowy_tundra: {
    sky: { top: '#9ab8e8', horizon: '#dfe9f7', bottom: '#c8d4e2', sun: { azimuth: -30, elevation: 35, color: '#ffffff', size: 6, glow: '#f4f8ff' } },
    fog: { color: '#dfe9f7', near: 22, far: 48 },
    ambient: { sky: '#eef4ff', ground: '#c8d0dc', intensity: 1.6 },
    key: { color: '#f4f8ff', intensity: 2.3 },
    fill: { color: '#c8d8f4', intensity: 0.8 },
    terrainLight: 1,
    terrain: 'snowy',
    ground: '#f3f8fa',
  },
  cherry_grove: {
    sky: { ...daySky, horizon: '#d6dcff' },
    fog: { color: '#d6dcff', near: 24, far: 52 },
    ...day,
    terrainLight: 1,
    terrain: 'cherry',
    ground: '#6fa64a',
  },
  desert: {
    sky: { top: '#6e9cf0', horizon: '#d8e2f0', bottom: '#d8c9a0', sun: { azimuth: 20, elevation: 60, color: '#fffbe0', size: 7, glow: '#fff3b0' } },
    fog: { color: '#e2dccb', near: 24, far: 54 },
    ambient: { sky: '#f4ecd8', ground: '#a08a5a', intensity: 1.5 },
    key: { color: '#fff1d6', intensity: 2.9 },
    fill: { color: '#d8c8a8', intensity: 0.6 },
    terrainLight: 1,
    terrain: 'desert',
    ground: '#dbcfa0',
  },
  ocean: { sky: daySky, fog: { color: '#c0d8ff', near: 26, far: 56 }, ...day, terrainLight: 1, terrain: 'ocean', ground: '#dbcfa0' },
  underwater: {
    sky: { top: '#3a7cc4', horizon: '#1d4f8a', bottom: '#0d2a52' },
    fog: { color: '#1d4f8a', near: 4, far: 30 },
    ambient: { sky: '#7fb8ff', ground: '#1d3a5a', intensity: 1.2 },
    key: { color: '#a8d4ff', intensity: 1.7 },
    fill: { color: '#3a78c8', intensity: 0.8 },
    terrainLight: 0.8,
    terrain: 'underwater',
    ground: '#c2b88a',
  },
  lush_cave: {
    sky: { top: '#1a2416', horizon: '#26331e', bottom: '#141a10' },
    fog: { color: '#1f2a18', near: 12, far: 34 },
    ambient: { sky: '#a8d080', ground: '#3a4a2a', intensity: 1.1 },
    key: { color: '#ffe6b0', intensity: 1.8 },
    fill: { color: '#7ab060', intensity: 0.6 },
    terrainLight: 0.75,
    terrain: 'lush_cave',
    ground: '#5a7a2c',
  },
  deep_dark: {
    sky: { top: '#040a0d', horizon: '#06121a', bottom: '#020507' },
    fog: { color: '#03090c', near: 4, far: 24 },
    ambient: { sky: '#3a6a7a', ground: '#081014', intensity: 0.6 },
    key: { color: '#9adfe8', intensity: 1.2 },
    fill: { color: '#2a6a78', intensity: 0.5 },
    terrainLight: 0.35,
    terrain: 'deep_dark',
    ground: '#0d2b33',
  },
  nether: {
    sky: { top: '#2a0a08', horizon: '#5a1a12', bottom: '#1a0605' },
    fog: { color: '#4a1410', near: 14, far: 40 },
    ambient: { sky: '#ffb08a', ground: '#4a1a10', intensity: 1.1 },
    key: { color: '#ffc8a0', intensity: 2 },
    fill: { color: '#c85a30', intensity: 0.7 },
    terrainLight: 0.85,
    terrain: 'nether',
    ground: '#6f3534',
  },
  sunset: {
    sky: { top: '#3a4a8a', horizon: '#ff9a5a', bottom: '#5a4a5a', sun: { azimuth: -60, elevation: 4, color: '#ffd27a', size: 8, glow: '#ff8a40' } },
    fog: { color: '#e8956a', near: 24, far: 52 },
    ambient: { sky: '#ffc8a0', ground: '#4a3a3a', intensity: 1.1 },
    key: { color: '#ffb070', intensity: 2.4 },
    fill: { color: '#8a7ab8', intensity: 0.6 },
    terrainLight: 0.85,
    terrain: 'plains',
    ground: '#6fa64a',
  },
  night: {
    sky: { top: '#03050f', horizon: '#0f1a33', bottom: '#05070c', stars: 900, sun: { azimuth: 30, elevation: 45, color: '#e8ecf4', size: 5 } },
    fog: { color: '#0b1222', near: 18, far: 44 },
    ambient: { sky: '#6a7ab8', ground: '#10141f', intensity: 0.8 },
    key: { color: '#b8c8f0', intensity: 1.2 },
    fill: { color: '#3a4a7a', intensity: 0.4 },
    terrainLight: 0.4,
    terrain: 'plains',
    ground: '#2e4a24',
  },
};

// ---------------------------------------------------------------- terrain

/** A block whose top is at height `y` (it fills y - 1 .. y) and whose centre is at x, z. */
export interface Placement {
  block: BlockName;
  x: number;
  y: number;
  z: number;
}

export interface Terrain {
  blocks: Placement[];
  /** A water surface at this height over the whole area (ocean) or a ceiling of water seen from below (underwater). */
  water: { y: number; radius: number } | null;
}

/** Half the size of the landscape in blocks. */
export const TERRAIN_RADIUS = 34;
/** Around the model the ground is flat and free up to this distance. */
const CLEAR = 12;
/** Trees and other features keep at least this far from the model. */
const FEATURE_CLEAR = 15;

/** Small deterministic random generator (mulberry32), so a scene looks the same every time. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise in 0..1. */
function noise(seed: number, scale: number): (x: number, z: number) => number {
  const hash = (x: number, z: number) => {
    let h = Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(seed, 982451653);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const fade = (t: number) => t * t * (3 - 2 * t);
  return (x, z) => {
    const fx = x / scale;
    const fz = z / scale;
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const tx = fade(fx - x0);
    const tz = fade(fz - z0);
    const a = hash(x0, z0) + (hash(x0 + 1, z0) - hash(x0, z0)) * tx;
    const b = hash(x0, z0 + 1) + (hash(x0 + 1, z0 + 1) - hash(x0, z0 + 1)) * tx;
    return a + (b - a) * tz;
  };
}

interface Recipe {
  surface: BlockName;
  filler: BlockName;
  deep: BlockName;
  /** Height of the hills towards the edge, in blocks. */
  hills: number;
  /** Optional surface patches: block and share of columns. */
  patches?: [BlockName, number];
  /** A cave: walls at the edge and a ceiling at this height. */
  ceiling?: { height: number; block: BlockName; hanging?: [BlockName, number] };
  features?: (put: (block: BlockName, x: number, y: number, z: number) => void, x: number, y: number, z: number, rnd: () => number) => void;
  /** Share of eligible columns that get a feature. */
  density?: number;
}

const tree =
  (log: BlockName, leaves: BlockName, wide = false) =>
  (put: (block: BlockName, x: number, y: number, z: number) => void, x: number, y: number, z: number, rnd: () => number) => {
    const height = 4 + Math.floor(rnd() * 2) + (wide ? 1 : 0);
    for (let i = 1; i <= height; i++) put(log, x, y + i, z);
    const top = y + height;
    const r = wide ? 3 : 2;
    for (let dy = -1; dy <= 1; dy++) {
      const reach = dy === 1 ? r - 1 : r;
      for (let dx = -reach; dx <= reach; dx++) {
        for (let dz = -reach; dz <= reach; dz++) {
          if (dx === 0 && dz === 0 && dy < 1) continue;
          // Round off the corners.
          if (Math.abs(dx) === reach && Math.abs(dz) === reach && (dy === 1 || rnd() < 0.6)) continue;
          put(leaves, x + dx, top + dy, z + dz);
        }
      }
    }
    put(leaves, x, top + 2, z);
  };

const spruce = (put: (block: BlockName, x: number, y: number, z: number) => void, x: number, y: number, z: number, rnd: () => number) => {
  const height = 6 + Math.floor(rnd() * 3);
  for (let i = 1; i <= height; i++) put('spruce_log', x, y + i, z);
  for (let i = 2; i <= height + 1; i++) {
    const r = i > height ? 0 : (height - i) % 2 === 0 ? 2 : 1;
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if ((dx || dz || i > height) && Math.abs(dx) + Math.abs(dz) <= r + 1) put('spruce_leaves', x + dx, y + i, z + dz);
  }
};

const cactus = (put: (block: BlockName, x: number, y: number, z: number) => void, x: number, y: number, z: number, rnd: () => number) => {
  const height = 1 + Math.floor(rnd() * 3);
  for (let i = 1; i <= height; i++) put('cactus', x, y + i, z);
};

const pillar =
  (block: BlockName, cap?: BlockName) =>
  (put: (block: BlockName, x: number, y: number, z: number) => void, x: number, y: number, z: number, rnd: () => number) => {
    const height = 2 + Math.floor(rnd() * 4);
    for (let i = 1; i <= height; i++) put(block, x, y + i, z);
    if (cap) put(cap, x, y + height + 1, z);
  };

const recipes: Record<TerrainKind, Recipe> = {
  plains: { surface: 'grass_block', filler: 'dirt', deep: 'stone', hills: 7, features: tree('oak_log', 'oak_leaves'), density: 0.012 },
  snowy: { surface: 'snowy_grass', filler: 'dirt', deep: 'stone', hills: 6, patches: ['packed_ice', 0.04], features: spruce, density: 0.012 },
  cherry: { surface: 'grass_block', filler: 'dirt', deep: 'stone', hills: 9, features: tree('cherry_log', 'cherry_leaves', true), density: 0.01 },
  desert: { surface: 'sand', filler: 'sand', deep: 'sandstone', hills: 5, features: cactus, density: 0.012 },
  ocean: { surface: 'sand', filler: 'sand', deep: 'stone', hills: 0 },
  underwater: { surface: 'sand', filler: 'sand', deep: 'stone', hills: 2, patches: ['gravel', 0.15], features: pillar('prismarine', 'sea_lantern'), density: 0.008 },
  lush_cave: {
    surface: 'moss_block',
    filler: 'dirt',
    deep: 'stone',
    hills: 2,
    patches: ['clay', 0.08],
    ceiling: { height: 10, block: 'stone', hanging: ['azalea_leaves', 0.12] },
    features: pillar('stone', 'glowstone'),
    density: 0.006,
  },
  deep_dark: {
    surface: 'sculk',
    filler: 'deepslate',
    deep: 'deepslate',
    hills: 2,
    patches: ['cobbled_deepslate', 0.15],
    ceiling: { height: 11, block: 'deepslate', hanging: ['sculk', 0.05] },
    features: pillar('deepslate'),
    density: 0.008,
  },
  nether: {
    surface: 'crimson_nylium',
    filler: 'netherrack',
    deep: 'netherrack',
    hills: 10,
    patches: ['soul_sand', 0.06],
    features: pillar('basalt', 'glowstone'),
    density: 0.01,
  },
};

/** Builds the block landscape of a scene. The model area (radius 12 around the origin, room for the camera) is flat ground at height 0. */
export function generateTerrain(kind: TerrainKind, radius = TERRAIN_RADIUS): Terrain {
  const recipe = recipes[kind];
  const rnd = random(kind.length * 7919 + recipe.hills);
  const hill = noise(17 + kind.length, 6);
  const detail = noise(91 + kind.length, 2.5);
  const placed = new Map<string, Placement>();
  const put = (block: BlockName, x: number, y: number, z: number) => {
    if (Math.hypot(x, z) > radius + 0.5) return;
    placed.set(`${x},${y},${z}`, { block, x, y, z });
  };
  const height = (x: number, z: number) => {
    const d = Math.hypot(x, z);
    if (d <= CLEAR) return 0;
    const ramp = Math.min(1, (d - CLEAR) / (radius - CLEAR));
    return Math.floor(recipe.hills * ramp * (0.35 + 0.65 * hill(x, z)) + (detail(x, z) - 0.5) * ramp * 1.2);
  };

  const ocean = kind === 'ocean';
  const lava = kind === 'nether';
  for (let x = -radius; x <= radius; x++) {
    for (let z = -radius; z <= radius; z++) {
      const d = Math.hypot(x, z);
      if (d > radius + 0.5) continue;
      // The ocean is a sea floor three blocks down with a small sand island for the model.
      let h = ocean ? (d <= 6 ? 0 : -3) : height(x, z);
      // Nether lava pools in the low parts outside the model area.
      if (lava && d > CLEAR + 2 && h <= 0 && detail(x, z) < 0.22) {
        put('lava', x, -0.125, z);
        h = -1;
      }
      const neighbours = [height(x + 1, z), height(x - 1, z), height(x, z + 1), height(x, z - 1)];
      const edge = d > radius - 1.5;
      const bottom = edge ? Math.min(h, -2) - 1 : Math.min(h, ...neighbours) - 1;
      for (let y = h; y > bottom; y--) {
        const block = y === h ? recipe.surface : h - y <= 2 ? recipe.filler : recipe.deep;
        put(block, x, y, z);
      }
      if (recipe.patches && d > CLEAR && rnd() < recipe.patches[1]) put(recipe.patches[0], x, h, z);
      if (recipe.features && d >= FEATURE_CLEAR && d < radius - 2 && rnd() < (recipe.density ?? 0)) recipe.features(put, x, h, z, rnd);

      const ceiling = recipe.ceiling;
      if (ceiling) {
        const top = ceiling.height + Math.floor(hill(z, x) * 2);
        put(ceiling.block, x, top, z);
        // Walls close the cave at its rim.
        if (d > radius - 2.5) for (let y = h + 1; y < top; y++) put(ceiling.block, x, y, z);
        else if (ceiling.hanging && rnd() < ceiling.hanging[1]) put(ceiling.hanging[0], x, top - 1, z);
      }
    }
  }
  return {
    blocks: [...placed.values()],
    water: ocean ? { y: -0.125, radius } : kind === 'underwater' ? { y: 14, radius } : null,
  };
}
