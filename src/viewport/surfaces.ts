import {
  CanvasTexture,
  DoubleSide,
  ClampToEdgeWrapping,
  LinearSRGBColorSpace,
  MeshStandardMaterial,
  NearestFilter,
  PMREMGenerator,
  RepeatWrapping,
  SRGBColorSpace,
  Texture as GpuTexture,
  type HemisphereLight,
  type Scene,
  type WebGPURenderer,
} from 'three/webgpu';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { cuboidFaces, textureSlots } from '../core/types';
import type { AppState, Cuboid, DocState, Material, SceneObject, Texture, TextureSlot } from '../core/types';
import { textureBlob } from './textureImage';
import { frameCount } from '../core/minecraft/paintRegions';
import type { PixelTextures } from './pixelPaintView';

/*
 * Texture orientation: document UVs have v pointing up, so v = 0 is the BOTTOM row of the image.
 * Images are flipped vertically while decoding (`imageOrientation: 'flipY'`) and uploaded with
 * `flipY = false`: ImageBitmaps ignore three's flipY on the WebGL2 backend, so flipping at decode
 * time is the one way that behaves the same on both backends. Normal maps are read in the OpenGL
 * convention (green = up), like glTF.
 */

const ANISOTROPY = 4;
/**
 * In material shading the environment replaces the hemisphere light. At this intensity it adds
 * about as much diffuse light as that did, so colours come out as bright as in solid shading.
 */
const ENVIRONMENT_INTENSITY = 0.25;

type MapProperty = 'map' | 'normalMap' | 'roughnessMap' | 'metalnessMap' | 'emissiveMap' | 'aoMap';

/** Which three.js material property each slot binds to, and whether the image holds colours (sRGB). */
const slotBinding: Record<TextureSlot, { property: MapProperty; color: boolean }> = {
  baseColor: { property: 'map', color: true },
  normal: { property: 'normalMap', color: false },
  // Our scalar maps are greyscale images, so whichever channel three reads holds the value.
  roughness: { property: 'roughnessMap', color: false },
  metallic: { property: 'metalnessMap', color: false },
  emissive: { property: 'emissiveMap', color: true },
  occlusion: { property: 'aoMap', color: false },
};

/** Textures that are being painted show their live pixels instead of their decoded image; see paintView.ts. */
export interface PaintedTextures {
  /** The live GPU texture for a document texture, or null to show its own image. */
  liveTexture(texture: Texture, color: boolean): GpuTexture | null;
  /** A GPU texture with exactly this document texture's pixels, to show while its image is being decoded. */
  standIn(texture: Texture, color: boolean): GpuTexture | null;
  /** A texture to show as this material's base colour while its height texture is painted. */
  heightPreview(materialId: string): GpuTexture | null;
}

interface Decoded {
  /** Null while decoding (or if the image could not be decoded). */
  bitmap: ImageBitmap | null;
  srgb: GpuTexture | null;
  linear: GpuTexture | null;
  /** Colours with nearest-neighbour filtering, for pixel art (Minecraft textures). */
  pixel: GpuTexture | null;
  disposed: boolean;
}

interface Variant {
  material: MeshStandardMaterial;
  /** The document material whose values `material` currently shows. */
  source: Material | null;
}

function configure<T extends GpuTexture>(texture: T, color: boolean): T {
  texture.colorSpace = color ? SRGBColorSpace : LinearSRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.anisotropy = ANISOTROPY;
  return texture;
}

/** A Minecraft texture: sharp pixels, no repeating, no mip maps. */
function configurePixels<T extends GpuTexture>(texture: T): T {
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}

/**
 * An animated (flipbook) texture shows one frame: the UVs of a face address one frame, so the texture is
 * scaled to the frame's share of the image and moved to the frame (frame 0 is the top of the image).
 */
function showFrame(gpu: GpuTexture, texture: Texture, frame: number): void {
  const frames = texture.animation ? frameCount(texture) : 1;
  const repeat = 1 / frames;
  const offset = (frames - 1 - frame) / frames;
  if (gpu.repeat.y !== repeat || gpu.offset.y !== offset) {
    gpu.repeat.set(1, repeat);
    gpu.offset.set(0, offset);
  }
}

/** Same surface options as the clay: double sided, and pushed back so edge overlays do not z-fight. */
function surface(): MeshStandardMaterial {
  return new MeshStandardMaterial({ side: DoubleSide, fog: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
}

/** A numbered, coloured grid: shows stretching, mirroring and which way is up. A1 is at u = 0, v = 0. */
function checkerCanvas(): HTMLCanvasElement {
  const cells = 8;
  const size = 1024;
  const cell = size / cells;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `600 ${cell * 0.3}px "Segoe UI", system-ui, sans-serif`;
  for (let row = 0; row < cells; row++) {
    for (let column = 0; column < cells; column++) {
      const light = (row + column) % 2 === 0;
      // The hue runs along u, the lightness rises a little along v.
      const hue = (column / cells) * 360;
      g.fillStyle = `hsl(${hue} ${light ? 38 : 46}% ${(light ? 68 : 40) + row * 1.5}%)`;
      // Canvas y points down; row 0 (v = 0) is at the bottom.
      const x = column * cell;
      const y = size - (row + 1) * cell;
      g.fillRect(x, y, cell, cell);
      g.fillStyle = light ? 'rgb(20 24 26 / 0.8)' : 'rgb(255 255 255 / 0.88)';
      g.fillText(`${String.fromCharCode(65 + column)}${row + 1}`, x + cell / 2, y + cell / 2);
    }
  }
  g.strokeStyle = 'rgb(20 24 26 / 0.55)';
  g.lineWidth = 2;
  for (let i = 0; i <= cells; i++) {
    g.beginPath();
    g.moveTo(i * cell, 0);
    g.lineTo(i * cell, size);
    g.moveTo(0, i * cell);
    g.lineTo(size, i * cell);
    g.stroke();
  }
  return canvas;
}

/**
 * What objects are surfaced with when they do not show the clay: their PBR material in `material`
 * shading, or the UV checker in the UV workspace. Owns the GPU textures (one decode per document
 * `Texture` object) and the three.js materials (one per document material id and variant, updated
 * in place when the document material changes, so scrubbing and undo never compile a shader).
 */
export class SurfaceMaterials {
  private readonly textures = new Map<Texture, Decoded>();
  private readonly materials = new Map<string, { plain: Variant | null; mapped: Variant | null }>();
  private environment: GpuTexture | null = null;
  private checker: MeshStandardMaterial | null = null;
  /** Per document texture, the material of cuboid faces that show it. */
  private readonly faceMaterials = new Map<Texture, MeshStandardMaterial>();
  /** What a cuboid face without a texture looks like, and what a disabled face (not drawn) is. */
  private blankFace: MeshStandardMaterial | null = null;
  private hiddenFace: MeshStandardMaterial | null = null;
  /** The six materials of a cuboid element, kept while its faces show the same textures. */
  private readonly cuboidSets = new WeakMap<Cuboid, { textures: DocState['textures']; materials: MeshStandardMaterial[] }>();
  private renderer: WebGPURenderer | null = null;
  private sweptDocs: AppState['docs'] | null = null;
  /** Texture images being decoded right now. */
  private readonly decoding = new Set<Promise<void>>();
  /** Set by the engine: the paint workspace's live textures. */
  paint: PaintedTextures | null = null;
  /** Set by the engine: live pixel-art textures and animation frames of Minecraft faces. */
  pixels: PixelTextures | null = null;

  /** `onLoad` is called when a texture has been decoded and the scene should be drawn again. */
  constructor(private readonly onLoad: () => void) {
    if (import.meta.env.DEV) (window as unknown as { __tesselSurfaces: unknown }).__tesselSurfaces = this;
  }

  /** Builds the image-based lighting; `applyLighting` switches it on. Needs an initialised renderer. */
  init(renderer: WebGPURenderer): void {
    this.renderer = renderer;
    const pmrem = new PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    this.environment = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
  }

  /**
   * Material shading is lit by the environment as well, so that metals have something to reflect
   * and roughness shows; it takes the place of the `ambient` hemisphere light. Every other look
   * (solid, wireframe, the UV checker) keeps the plain studio lights, exactly as without materials.
   *
   * The hemisphere light is hidden, not dimmed: three refreshes light colours and intensities once
   * per animation frame, but which lights there are with every render. A screenshot renders another
   * look and then the viewport again within one frame, and both must come out right.
   */
  applyLighting(app: AppState, scene: Scene, ambient: HemisphereLight): void {
    const on = app.shading === 'material' && app.workspace !== 'uv';
    scene.environment = on ? this.environment : null;
    scene.environmentIntensity = ENVIRONMENT_INTENSITY;
    ambient.visible = !on;
  }

  /** Resolves when the texture images asked for so far are decoded; null if none is being decoded. */
  settled(): Promise<unknown> | null {
    return this.decoding.size > 0 ? Promise.all(this.decoding) : null;
  }

  /** The material `obj` is drawn with, or null for the clay. `hasUvs` refers to the rendered (evaluated) mesh. */
  pick(app: AppState, state: DocState, obj: SceneObject, hasUvs: boolean): MeshStandardMaterial | null {
    if (app.workspace === 'uv') return hasUvs ? this.checkerMaterial() : null;
    if (app.shading !== 'material') return null;
    const material = obj.materialId === null ? undefined : state.materials[obj.materialId];
    if (!material) return null;
    return this.material(material, hasUvs ? state.textures : null);
  }

  /**
   * The materials of a cuboid element's six faces, in `cuboidFaces` order (the order of its mesh's quads):
   * each face shows its texture with nearest-neighbour filtering, faces without a texture a neutral colour,
   * disabled faces nothing. Null in wireframe shading and for objects that are not cuboids.
   */
  cuboidMaterials(app: AppState, state: DocState, obj: SceneObject): MeshStandardMaterial[] | null {
    const cuboid = obj.cuboid;
    if (!cuboid || app.shading === 'wireframe') return null;
    const materials = cuboidFaces.map((name) => {
      const face = cuboid.faces[name];
      if (!face.enabled) return (this.hiddenFace ??= Object.assign(surface(), { visible: false }));
      const texture = face.texture === null ? undefined : state.textures[face.texture];
      return texture ? this.faceMaterial(texture) : this.blankFaceMaterial();
    });
    const cached = this.cuboidSets.get(cuboid);
    if (cached && cached.materials.length === 6 && cached.materials.every((m, i) => m === materials[i])) return cached.materials;
    this.cuboidSets.set(cuboid, { textures: state.textures, materials });
    return materials;
  }

  private blankFaceMaterial(): MeshStandardMaterial {
    if (!this.blankFace) {
      this.blankFace = surface();
      this.blankFace.color.set('#b9b2a6');
      this.blankFace.roughness = 0.95;
    }
    return this.blankFace;
  }

  /** The material for a texture; its image is bound as soon as it is decoded (the next sync checks again). */
  private faceMaterial(texture: Texture): MeshStandardMaterial {
    let material = this.faceMaterials.get(texture);
    if (!material) {
      material = surface();
      material.roughness = 1;
      // Cut-out transparency like the game's solid and cutout render types: no sorting needed.
      material.alphaTest = 0.1;
      this.faceMaterials.set(texture, material);
    }
    const next = this.pixels?.livePixels(texture) ?? this.gpuTexture(texture, true, true);
    if (next) showFrame(configurePixels(next), texture, this.pixels?.frameOf(texture) ?? 0);
    if (material.map !== next) {
      if ((material.map === null) !== (next === null)) material.needsUpdate = true;
      material.map = next;
    }
    return material;
  }

  private checkerMaterial(): MeshStandardMaterial {
    if (!this.checker) {
      this.checker = surface();
      this.checker.roughness = 0.9;
      this.checker.map = configure(new CanvasTexture(checkerCanvas()), true);
    }
    return this.checker;
  }

  /** `textures`: the document's textures for an object with UVs, null to render the scalar values only. */
  private material(source: Material, textures: DocState['textures'] | null): MeshStandardMaterial {
    let entry = this.materials.get(source.id);
    if (!entry) this.materials.set(source.id, (entry = { plain: null, mapped: null }));
    const variant = (entry[textures ? 'mapped' : 'plain'] ??= { material: surface(), source: null });
    const material = variant.material;
    if (variant.source !== source) {
      variant.source = source;
      material.color.set(source.baseColor);
      material.metalness = source.metallic;
      material.roughness = source.roughness;
      material.emissive.set(source.emissive);
      material.emissiveIntensity = source.emissiveStrength;
      material.normalScale.setScalar(source.normalScale);
    }
    if (textures) {
      // Checked on every sync: a texture may have finished decoding since.
      for (const slot of textureSlots) {
        const { property, color } = slotBinding[slot];
        const id = source.maps[slot];
        const texture = id === undefined ? undefined : textures[id];
        let next = texture ? this.gpuTexture(texture, color) : null;
        if (slot === 'baseColor') {
          const height = this.paint?.heightPreview(source.id);
          if (height) {
            // Shown untinted; the material's own values come back with the next sync after the preview.
            next = height;
            material.color.set('#ffffff');
            variant.source = null;
          }
        }
        const current = material[property];
        if (current === next) continue;
        // A map appearing or going away changes the shader; swapping one image for another does not.
        if ((current === null) !== (next === null)) material.needsUpdate = true;
        material[property] = next;
      }
    }
    return material;
  }

  /** The GPU texture for a document texture, or null while its image is still being decoded. */
  private gpuTexture(texture: Texture, color: boolean, pixelated = false): GpuTexture | null {
    const live = pixelated ? null : this.paint?.liveTexture(texture, color);
    if (live) return live;
    let decoded = this.textures.get(texture);
    if (!decoded) {
      const entry: Decoded = { bitmap: null, srgb: null, linear: null, pixel: null, disposed: false };
      this.textures.set(texture, (decoded = entry));
      const decoding = createImageBitmap(textureBlob(texture), { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' }).then(
        (bitmap) => {
          if (entry.disposed) return bitmap.close();
          entry.bitmap = bitmap;
          this.onLoad();
        },
        (error) => console.error(`Viewport: texture "${texture.name}" could not be decoded`, error),
      );
      this.decoding.add(decoding);
      void decoding.then(() => this.decoding.delete(decoding));
    }
    if (!decoded.bitmap) return pixelated ? null : (this.paint?.standIn(texture, color) ?? null);
    const key = pixelated ? 'pixel' : color ? 'srgb' : 'linear';
    if (!decoded[key]) {
      const gpu = pixelated ? configurePixels(new GpuTexture(decoded.bitmap)) : configure(new GpuTexture(decoded.bitmap), color);
      gpu.flipY = false;
      gpu.needsUpdate = true;
      decoded[key] = gpu;
    }
    return decoded[key];
  }

  /**
   * Frees what no open document uses any more: three materials whose document material is gone,
   * and textures that no material assigned to an object refers to. Looks at all open documents,
   * so switching tabs does not decode everything again. Call after every sync.
   */
  sweep(app: AppState): void {
    if (app.docs === this.sweptDocs) return;
    this.sweptDocs = app.docs;
    const docs = Object.values(app.docs);
    for (const [id, entry] of this.materials) {
      if (docs.some((doc) => doc.state.materials[id])) continue;
      entry.plain?.material.dispose();
      entry.mapped?.material.dispose();
      this.materials.delete(id);
    }
    if (this.textures.size === 0) return;
    const used = new Set<Texture>();
    for (const { state } of docs) {
      const seen = new Set<string>();
      for (const obj of Object.values(state.objects)) {
        if (obj.materialId === null || seen.has(obj.materialId)) continue;
        seen.add(obj.materialId);
        for (const id of Object.values(state.materials[obj.materialId]?.maps ?? {})) {
          if (state.textures[id]) used.add(state.textures[id]);
        }
      }
      for (const obj of Object.values(state.objects)) {
        if (!obj.cuboid) continue;
        for (const name of cuboidFaces) {
          const id = obj.cuboid.faces[name].texture;
          if (id !== null && state.textures[id]) used.add(state.textures[id]);
        }
      }
    }
    for (const [texture, material] of this.faceMaterials) {
      if (used.has(texture)) continue;
      material.dispose();
      this.faceMaterials.delete(texture);
    }
    const freed = new Set<GpuTexture>();
    for (const [texture, decoded] of this.textures) {
      if (used.has(texture)) continue;
      this.textures.delete(texture);
      if (decoded.srgb) freed.add(decoded.srgb);
      if (decoded.linear) freed.add(decoded.linear);
      if (decoded.pixel) freed.add(decoded.pixel);
      this.releaseTexture(decoded);
    }
    if (freed.size === 0) return;
    // No material may keep pointing at a disposed texture (three would upload it again).
    for (const entry of this.materials.values()) {
      const material = entry.mapped?.material;
      if (!material) continue;
      for (const { property } of Object.values(slotBinding)) {
        const bound = material[property];
        if (bound && freed.has(bound)) {
          material[property] = null;
          material.needsUpdate = true;
        }
      }
    }
  }

  private releaseTexture(decoded: Decoded): void {
    decoded.disposed = true;
    decoded.srgb?.dispose();
    decoded.linear?.dispose();
    decoded.pixel?.dispose();
    decoded.bitmap?.close();
  }

  /** Counts for leak checks in development. */
  stats() {
    const decoded = [...this.textures.values()];
    return {
      documentTextures: decoded.length,
      gpuTextures: decoded.reduce((n, d) => n + (d.srgb ? 1 : 0) + (d.linear ? 1 : 0) + (d.pixel ? 1 : 0), 0),
      materials: [...this.materials.values()].reduce((n, e) => n + (e.plain ? 1 : 0) + (e.mapped ? 1 : 0), 0),
      rendererTextures: this.renderer?.info.memory.textures ?? 0,
    };
  }

  dispose(): void {
    for (const entry of this.materials.values()) {
      entry.plain?.material.dispose();
      entry.mapped?.material.dispose();
    }
    this.materials.clear();
    this.textures.forEach((decoded) => this.releaseTexture(decoded));
    this.textures.clear();
    this.faceMaterials.forEach((material) => material.dispose());
    this.faceMaterials.clear();
    this.blankFace?.dispose();
    this.hiddenFace?.dispose();
    this.checker?.map?.dispose();
    this.checker?.dispose();
    this.environment?.dispose();
  }
}
