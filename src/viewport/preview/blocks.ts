// The blocks preview scenes are built from: which vanilla textures each face uses (read from the user's
// Minecraft assets, never bundled), how they are tinted, and a flat colour for when no assets are set.

export interface BlockLook {
  /** Texture ids per face; `side` is used for all four sides. */
  top: string;
  side: string;
  bottom: string;
  /** Multiplies greyscale textures (grass, leaves, water), #rrggbb. */
  tint?: string;
  /** Tinted only on the top (grass), with this overlay drawn tinted over the side texture. */
  sideOverlay?: string;
  /** Flat colours (top, side) without textures. */
  fallback: [string, string];
  /** Drawn with alpha (water, ice) or cut out (leaves). */
  alpha?: 'blend' | 'cutout';
  /** Light emitting blocks are not darkened by the scene light. */
  glow?: boolean;
}

const all = (texture: string, fallback: string, extra: Partial<BlockLook> = {}): BlockLook => ({
  top: texture,
  side: texture,
  bottom: texture,
  fallback: [fallback, fallback],
  ...extra,
});

const GRASS = '#79c05a';
const FOLIAGE = '#59ae30';

export const blocks = {
  grass_block: {
    top: 'block/grass_block_top',
    side: 'block/grass_block_side',
    bottom: 'block/dirt',
    tint: GRASS,
    sideOverlay: 'block/grass_block_side_overlay',
    fallback: ['#6fa64a', '#86603f'],
  },
  snowy_grass: { top: 'block/snow', side: 'block/grass_block_snow', bottom: 'block/dirt', fallback: ['#f3f8fa', '#b8a99a'] },
  dirt: all('block/dirt', '#86603f'),
  stone: all('block/stone', '#7d7d7d'),
  cobblestone: all('block/cobblestone', '#6e6e6e'),
  gravel: all('block/gravel', '#837d7a'),
  sand: all('block/sand', '#dbcfa0'),
  sandstone: { top: 'block/sandstone_top', side: 'block/sandstone', bottom: 'block/sandstone_bottom', fallback: ['#d8cb96', '#d1c08a'] },
  snow_block: all('block/snow', '#f3f8fa'),
  ice: all('block/ice', '#8db4f5', { alpha: 'blend' }),
  packed_ice: all('block/packed_ice', '#8eb3ee'),
  oak_log: { top: 'block/oak_log_top', side: 'block/oak_log', bottom: 'block/oak_log_top', fallback: ['#a7844f', '#6b5232'] },
  oak_leaves: all('block/oak_leaves', '#4a8a2a', { tint: FOLIAGE, alpha: 'cutout' }),
  spruce_log: { top: 'block/spruce_log_top', side: 'block/spruce_log', bottom: 'block/spruce_log_top', fallback: ['#6e5233', '#3b2913'] },
  spruce_leaves: all('block/spruce_leaves', '#3e623e', { tint: '#619961', alpha: 'cutout' }),
  cherry_log: { top: 'block/cherry_log_top', side: 'block/cherry_log', bottom: 'block/cherry_log_top', fallback: ['#d39ca0', '#3a1e25'] },
  cherry_leaves: all('block/cherry_leaves', '#e9a6c6', { alpha: 'cutout' }),
  cactus: { top: 'block/cactus_top', side: 'block/cactus_side', bottom: 'block/cactus_bottom', fallback: ['#64a03c', '#4f8a2c'], alpha: 'cutout' },
  water: all('block/water_still', '#3f76e4', { tint: '#3f76e4', alpha: 'blend' }),
  prismarine: all('block/prismarine', '#63a297'),
  sea_lantern: all('block/sea_lantern', '#d6e4dc', { glow: true }),
  moss_block: all('block/moss_block', '#5a7a2c'),
  azalea_leaves: all('block/azalea_leaves', '#5c7e2c', { alpha: 'cutout' }),
  clay: all('block/clay', '#a0a6b3'),
  glowstone: all('block/glowstone', '#d9b46a', { glow: true }),
  deepslate: { top: 'block/deepslate_top', side: 'block/deepslate', bottom: 'block/deepslate_top', fallback: ['#545458', '#4c4c50'] },
  cobbled_deepslate: all('block/cobbled_deepslate', '#4d4d51'),
  sculk: all('block/sculk', '#0d2b33'),
  netherrack: all('block/netherrack', '#6f3534'),
  crimson_nylium: { top: 'block/crimson_nylium', side: 'block/crimson_nylium_side', bottom: 'block/netherrack', fallback: ['#8f2020', '#6f3534'] },
  soul_sand: all('block/soul_sand', '#513e32'),
  basalt: { top: 'block/basalt_top', side: 'block/basalt_side', bottom: 'block/basalt_top', fallback: ['#545458', '#4a4a4e'] },
  magma_block: all('block/magma', '#8e3d16', { glow: true }),
  lava: all('block/lava_still', '#d4600e', { glow: true }),
  crafting_table: {
    top: 'block/crafting_table_top',
    side: 'block/crafting_table_side',
    bottom: 'block/oak_planks',
    fallback: ['#a0743f', '#7a5631'],
  },
} satisfies Record<string, BlockLook>;

export type BlockName = keyof typeof blocks;

/** Every texture a block uses, for loading. */
export function blockTextures(look: BlockLook): string[] {
  return [...new Set([look.top, look.side, look.bottom, ...(look.sideOverlay ? [look.sideOverlay] : [])])];
}
