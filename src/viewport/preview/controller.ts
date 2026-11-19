import {
  BufferGeometry,
  CircleGeometry,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  Fog,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  type CanvasTexture,
  type Node,
} from 'three/webgpu';
import { equirectUV, positionWorldDirection, texture as textureNode, uniform } from 'three/tsl';
import type { Preferences } from '../../core/preferences';
import type { PreviewScene } from '../../core/preview';
import { defaultDecoder, type DecodedImage, type MinecraftAssets } from '../../mcassets/loader';
import { getMinecraftAssets, onMinecraftAssetsChange, readSkinFile } from '../../mcassets';
import type { Stage } from '../docScene';
import type { ViewportPalette } from '../theme';
import { checkerBackground, skyTexture } from './backdrop';
import { buildCraftingTable, buildPlayer, defaultSkin, fallbackSkin } from './references';
import { DEFAULT_LIGHTS, generateTerrain, sceneLooks, type SceneLook, type TerrainKind } from './scenes';
import { BlockKit, buildTerrain, lightBlocks, type BlockMaterials } from './terrain';

// The preview options of the viewport (scene, background, ground, pixel grid, reference models) on
// the stage the user sees. Everything lives in its own group and in the stage's background, fog and
// lights; the document's objects are never touched, and `suspend` puts the plain stage back for
// pictures (view_screenshot) so those stay as they were.

/** The preferences this controller follows. */
type PreviewOptions = Pick<
  Preferences,
  'previewScene' | 'previewBackground' | 'previewBackgroundColor' | 'previewGround' | 'previewPixelGrid' | 'previewPlayer' | 'previewCraftingTable' | 'previewSkin'
>;

const PLAYER_AT = -2.25;
const TABLE_AT = 2.25;
const PIXEL_GRID_BLOCKS = 3;
const GROUND_RADIUS = 8;

interface Built {
  group: Group;
  dispose(): void;
}

export class PreviewController {
  /** Everything the preview adds to the scene. */
  readonly root = new Group();
  private readonly terrainGroup = new Group();
  private readonly referenceGroup = new Group();
  private readonly fog = new Fog(0, 10, 40);
  private readonly checker = checkerBackground();
  private readonly customColor = uniform(new Color());
  private readonly customNode = this.customColor;
  /** Made with the first sky; later skies only swap its texture. */
  private skyNode: ReturnType<typeof textureNode> | null = null;
  private readonly skies = new Map<string, CanvasTexture>();
  private readonly ground: Mesh<CircleGeometry, MeshStandardMaterial>;
  private readonly pixelGrid: Group;
  private readonly key: DirectionalLight;
  private readonly fill: DirectionalLight;
  private readonly unsubscribeAssets: () => void;

  private options: PreviewOptions | null = null;
  private palette: ViewportPalette | null = null;
  private pixelRatio = 1;
  private assets: MinecraftAssets | null = getMinecraftAssets();
  private kit = new BlockKit(this.assets);
  private terrain: (Built & { kind: TerrainKind; materials: BlockMaterials[] }) | null = null;
  private player: (Built & { skin: string }) | null = null;
  private table: Built | null = null;
  /** Bumped whenever what is being built changes; stale async builds throw their result away. */
  private generation = 0;
  private suspended = false;
  private disposed = false;

  constructor(
    private readonly stage: Stage,
    private readonly invalidate: () => void,
  ) {
    this.root.name = 'preview';
    this.root.add(this.terrainGroup, this.referenceGroup);
    [this.key, this.fill] = stage.lightRig.children as DirectionalLight[];

    this.ground = new Mesh(
      new CircleGeometry(GROUND_RADIUS, 64),
      new MeshStandardMaterial({ roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    // Before the grid, so the grid lines stay visible on it.
    this.ground.renderOrder = -3;
    this.ground.visible = false;
    this.root.add(this.ground);

    this.pixelGrid = pixelGrid();
    this.pixelGrid.visible = false;
    this.root.add(this.pixelGrid);

    stage.scene.add(this.root);
    this.unsubscribeAssets = onMinecraftAssetsChange(() => this.onAssets());
  }

  /** Follows the preferences; only what changed is rebuilt. */
  setOptions(preferences: Preferences): void {
    const next: PreviewOptions = {
      previewScene: preferences.previewScene,
      previewBackground: preferences.previewBackground,
      previewBackgroundColor: preferences.previewBackgroundColor,
      previewGround: preferences.previewGround,
      previewPixelGrid: preferences.previewPixelGrid,
      previewPlayer: preferences.previewPlayer,
      previewCraftingTable: preferences.previewCraftingTable,
      previewSkin: preferences.previewSkin,
    };
    const previous = this.options;
    if (previous && (Object.keys(next) as (keyof PreviewOptions)[]).every((key) => previous[key] === next[key])) return;
    this.options = next;
    this.update(previous);
  }

  /** The theme colours (solid background, checkerboard, ground and pixel grid in scene "none"). */
  setPalette(palette: ViewportPalette): void {
    this.palette = palette;
    this.applyEnvironment();
  }

  /** Device pixels per CSS pixel, for the size of the checkerboard cells. */
  setPixelRatio(ratio: number): void {
    if (ratio === this.pixelRatio) return;
    this.pixelRatio = ratio;
    this.applyEnvironment();
  }

  /**
   * Called before each frame: the scene fog keeps its distance from the point the camera looks at.
   * `pulledBack` is how much further away the drawing camera stands than `distance` (orthographic).
   */
  beforeDraw(distance: number, pulledBack = 0): void {
    const look = this.look();
    if (!look?.fog || this.suspended) return;
    this.fog.near = look.fog.near + distance + pulledBack;
    this.fog.far = look.fog.far + distance * 2 + pulledBack;
  }

  /** Puts the plain stage back (for a picture); the returned function restores the preview. */
  suspend(): () => void {
    if (this.suspended) return () => {};
    this.suspended = true;
    this.applyEnvironment();
    return () => {
      this.suspended = false;
      this.applyEnvironment();
    };
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.unsubscribeAssets();
    this.stage.scene.remove(this.root);
    this.restoreStage();
    this.terrain?.dispose();
    this.player?.dispose();
    this.table?.dispose();
    this.kit.dispose();
    this.ground.geometry.dispose();
    this.ground.material.dispose();
    this.pixelGrid.traverse((o) => {
      if (o instanceof LineSegments) {
        o.geometry.dispose();
        (o.material as LineBasicMaterial).dispose();
      }
    });
    for (const sky of this.skies.values()) sky.dispose();
  }

  // ---------------------------------------------------------------- internals

  private look(): SceneLook | null {
    const scene = this.options?.previewScene ?? 'none';
    return scene === 'none' ? null : sceneLooks[scene];
  }

  private update(previous: PreviewOptions | null): void {
    const options = this.options!;
    this.applyEnvironment();
    if (!previous || previous.previewScene !== options.previewScene) this.rebuildTerrain();
    if (!previous || previous.previewPlayer !== options.previewPlayer || previous.previewSkin !== options.previewSkin) this.rebuildPlayer();
    if (!previous || previous.previewCraftingTable !== options.previewCraftingTable) this.rebuildTable();
  }

  /** New assets (or none any more): everything textured is built again. */
  private onAssets(): void {
    const assets = getMinecraftAssets();
    if (assets === this.assets) return;
    this.assets = assets;
    this.generation++;
    this.terrain?.dispose();
    this.terrain = null;
    this.terrainGroup.clear();
    this.table?.dispose();
    this.table = null;
    this.player?.dispose();
    this.player = null;
    this.referenceGroup.clear();
    this.kit.dispose();
    this.kit = new BlockKit(assets);
    if (!this.options) return;
    this.rebuildTerrain();
    this.rebuildPlayer();
    this.rebuildTable();
  }

  /** Background, fog, lights, ground plane and pixel grid: everything that needs no loading. */
  private applyEnvironment(): void {
    const options = this.options;
    const palette = this.palette;
    if (!options || !palette || this.disposed) return;
    const scene = this.stage.scene;
    const look = this.suspended ? null : this.look();
    this.root.visible = !this.suspended;

    if (this.suspended) {
      this.restoreStage();
    } else if (look) {
      const sky = this.sky(options.previewScene);
      if (this.skyNode) this.skyNode.value = sky;
      else this.skyNode = textureNode(sky, equirectUV(positionWorldDirection));
      scene.backgroundNode = this.skyNode;
    } else if (options.previewBackground === 'checkerboard') {
      const dark = palette.background;
      this.checker.set(dark, palette.gridMinor, Math.round(10 * this.pixelRatio));
      scene.backgroundNode = this.checker.node as unknown as Node;
    } else if (options.previewBackground === 'custom') {
      this.customColor.value.set(options.previewBackgroundColor);
      scene.backgroundNode = this.customNode as unknown as Node;
    } else {
      scene.backgroundNode = null;
    }

    if (look?.fog) {
      this.fog.color.set(look.fog.color);
      scene.fog = this.fog;
    } else {
      scene.fog = this.stage.grid.fog;
    }

    const lights = look ?? DEFAULT_LIGHTS;
    this.stage.ambient.color.set(lights.ambient.sky);
    this.stage.ambient.groundColor.set(lights.ambient.ground);
    this.stage.ambient.intensity = lights.ambient.intensity;
    this.key.color.set(lights.key.color);
    this.key.intensity = lights.key.intensity;
    this.fill.color.set(lights.fill.color);
    this.fill.intensity = lights.fill.intensity;

    // Scenes with block terrain bring their own ground.
    this.ground.visible = options.previewGround && !look?.terrain;
    this.ground.material.color.set(look ? look.ground : palette.gridMajor);
    this.pixelGrid.visible = options.previewPixelGrid;
    const [minor, major] = this.pixelGrid.children as LineSegments[];
    for (const line of [minor, major]) (line.material as LineBasicMaterial).color.set(look ? '#ffffff' : palette.caption);

    if (this.terrain && look) lightBlocks(this.terrain.materials, look.terrainLight);
    this.invalidate();
  }

  private restoreStage(): void {
    const scene = this.stage.scene;
    scene.backgroundNode = null;
    scene.fog = this.stage.grid.fog;
    this.stage.ambient.color.set(DEFAULT_LIGHTS.ambient.sky);
    this.stage.ambient.groundColor.set(DEFAULT_LIGHTS.ambient.ground);
    this.stage.ambient.intensity = DEFAULT_LIGHTS.ambient.intensity;
    this.key.color.set(DEFAULT_LIGHTS.key.color);
    this.key.intensity = DEFAULT_LIGHTS.key.intensity;
    this.fill.color.set(DEFAULT_LIGHTS.fill.color);
    this.fill.intensity = DEFAULT_LIGHTS.fill.intensity;
  }

  private sky(scene: PreviewScene): CanvasTexture {
    let sky = this.skies.get(scene);
    if (!sky) {
      sky = skyTexture(sceneLooks[scene as Exclude<PreviewScene, 'none'>].sky);
      this.skies.set(scene, sky);
    }
    return sky;
  }

  private rebuildTerrain(): void {
    const kind = this.look()?.terrain ?? null;
    if (this.terrain?.kind === kind) return;
    this.terrain?.dispose();
    this.terrain = null;
    this.terrainGroup.clear();
    if (!kind) return;
    const run = ++this.generation;
    const kit = this.kit;
    buildTerrain(generateTerrain(kind), kit).then(
      (built) => {
        if (run !== this.generation || this.disposed || kit !== this.kit) return built.dispose();
        this.terrain = { ...built, kind };
        this.terrainGroup.add(built.group);
        this.applyEnvironment();
      },
      (error) => console.error('Preview scene could not be built', error),
    );
  }

  private rebuildPlayer(): void {
    const options = this.options!;
    const want = options.previewPlayer ? options.previewSkin : null;
    if (want === null) {
      this.player?.dispose();
      if (this.player) this.referenceGroup.remove(this.player.group);
      this.player = null;
      return;
    }
    if (this.player?.skin === want) return;
    const assets = this.assets;
    void loadSkin(want, assets).then((skin) => {
      if (this.disposed || assets !== this.assets || this.options?.previewSkin !== want || !this.options.previewPlayer) return;
      this.player?.dispose();
      if (this.player) this.referenceGroup.remove(this.player.group);
      const built = buildPlayer(skin);
      built.group.position.x = PLAYER_AT;
      this.player = { ...built, skin: want };
      this.referenceGroup.add(built.group);
      this.invalidate();
    });
  }

  private rebuildTable(): void {
    const show = this.options!.previewCraftingTable;
    if (!show) {
      this.table?.dispose();
      if (this.table) this.referenceGroup.remove(this.table.group);
      this.table = null;
      this.invalidate();
      return;
    }
    if (this.table) return;
    const kit = this.kit;
    void buildCraftingTable(kit, this.assets).then((built) => {
      if (this.disposed || kit !== this.kit || !this.options?.previewCraftingTable || this.table) return built.dispose();
      built.group.position.x = TABLE_AT;
      this.table = built;
      this.referenceGroup.add(built.group);
      this.invalidate();
    });
  }
}

/** The skin for the reference player: the picked file, else the default from the assets, else a made-up one. */
export async function loadSkin(path: string, assets: MinecraftAssets | null): Promise<DecodedImage> {
  if (path) {
    try {
      const image = await defaultDecoder(await readSkinFile(path));
      if (image && image.width === 64 && (image.height === 64 || image.height === 32)) return image;
      console.warn(`Preview skin ${path} is not a 64x64 or 64x32 PNG`);
    } catch (error) {
      console.warn(`Preview skin ${path} could not be read`, error);
    }
  }
  return (await defaultSkin(assets)) ?? fallbackSkin();
}

/** A 1/16 block grid over a few blocks around the origin, block borders stronger. */
function pixelGrid(): Group {
  const half = PIXEL_GRID_BLOCKS / 2;
  const steps = PIXEL_GRID_BLOCKS * 16;
  const minor: number[] = [];
  const major: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = -half + i / 16;
    // Blocks are centred on whole numbers, so their borders are at the halves.
    const target = i % 16 === 0 ? major : minor;
    target.push(t, 0, -half, t, 0, half, -half, 0, t, half, 0, t);
  }
  const group = new Group();
  group.name = 'preview-pixel-grid';
  // Just above the ground and terrain tops; drawn over them like the editor grid.
  group.position.y = 0.001;
  for (const [positions, opacity] of [
    [minor, 0.16],
    [major, 0.45],
  ] as const) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    const line = new LineSegments(geometry, new LineBasicMaterial({ transparent: true, opacity, depthWrite: false, fog: false }));
    line.renderOrder = -1;
    line.frustumCulled = false;
    group.add(line);
  }
  return group;
}

