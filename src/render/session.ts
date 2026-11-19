// One path-tracing renderer: its own WebGL2 context and canvas (independent of the WebGPU viewport),
// the three.js scene of the document being rendered, and the loop that accumulates samples.
import {
  Box3,
  CircleGeometry,
  DataTexture,
  DataUtils,
  EquirectangularReflectionMapping,
  FrontSide,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  MeshStandardMaterial,
  NoToneMapping,
  RGBAFormat,
  RepeatWrapping,
  Sphere,
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
  type Texture,
  type WebGLRenderTarget,
} from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { PhysicalCamera, WebGLPathTracer } from 'three-gpu-pathtracer';
import { MeshBVH, type MeshBVHOptions } from 'three-mesh-bvh';
import type { RenderJob, RenderSettings } from '../core/render';
import type { DocState } from '../core/types';
import { collectItems } from '../io/scene';
import { buildThreeScene, type ThreeScene } from '../io/threeScene';
import type { BvhReply, BvhRequest } from './bvhWorker';
import { buildEnvironment } from './environment';
import { OutputMaterial } from './output';

export interface RenderProgress {
  phase: 'preparing' | 'rendering' | 'encoding';
  /** Samples per pixel so far, and the number asked for. */
  samples: number;
  targetSamples: number;
  seconds: number;
  maxSeconds: number;
}

export interface RenderControl {
  /** Set to a message to abort the render with that error. */
  cancelled: string | null;
  /** Set to finish with the samples there are. */
  stop: boolean;
  onProgress(progress: RenderProgress): void;
}

/** How long one piece of GPU work may take, so that the rest of the app keeps drawing. */
const TILE_MS = 45;
/** A shader that has not compiled after this many seconds never will. */
const COMPILE_SECONDS = 600;
/** The preview is refreshed this often at most. */
const PREVIEW_MS = 400;
/** Memory the textures of all materials may take on the GPU, in bytes. */
const TEXTURE_BUDGET = 512 * 1024 * 1024;

const messages = new MessageChannel();
const waiting: (() => void)[] = [];
messages.port1.onmessage = () => waiting.shift()?.();

/** Gives the event loop a turn. Timers are slowed down to one per second in a hidden window, messages are not. */
function tick(ms = 0): Promise<void> {
  if (ms > 0 && !document.hidden) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve) => {
    waiting.push(resolve);
    messages.port2.postMessage(0);
  });
}

/**
 * Resolves when the GPU has finished what was sent to it. Without this, samples would be queued
 * faster than they are computed and the whole app would stall behind them.
 */
async function gpuDone(gl: WebGL2RenderingContext, expected = 0): Promise<void> {
  if (document.hidden) {
    // Nobody is watching: block rather than spin through a throttled event loop.
    gl.finish();
    return tick();
  }
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!sync) return tick(1);
  gl.flush();
  try {
    // Timers are too coarse to wait with (4 ms and more): sleep through most of the expected time, then look often.
    if (expected > 6) await tick(expected * 0.7);
    for (;;) {
      const status = gl.clientWaitSync(sync, 0, 0);
      if (status !== gl.TIMEOUT_EXPIRED) return;
      await tick();
      if (gl.isContextLost()) return;
    }
  } finally {
    gl.deleteSync(sync);
  }
}

/** Runs the BVH construction in a worker (see bvhWorker.ts), or on the main thread if the worker fails. */
class BvhBuilder {
  private worker: Worker | null = null;

  generate(geometry: BufferGeometry, options: MeshBVHOptions = {}): Promise<MeshBVH> {
    const { onProgress: _ignored, ...plain } = options as MeshBVHOptions & { onProgress?: unknown };
    return new Promise<MeshBVH>((resolve, reject) => {
      const position = geometry.attributes.position.array as Float32Array;
      const index = geometry.index ? (geometry.index.array as Uint32Array) : null;
      const local = () => {
        this.dispose();
        // Once the arrays have gone to the worker there is nothing left to build from here.
        if (position.byteLength === 0) return reject(new Error('Rendering failed: the geometry could not be prepared'));
        try {
          resolve(new MeshBVH(geometry, plain));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      let worker: Worker;
      try {
        worker = this.worker ??= new Worker(new URL('./bvhWorker.ts', import.meta.url), { type: 'module' });
      } catch {
        return local();
      }
      worker.onerror = local;
      worker.onmessage = ({ data }: MessageEvent<BvhReply>) => {
        if (data.error !== null) return reject(new Error(`Rendering failed: ${data.error}`));
        // The worker took the arrays; put them back before the BVH looks at the geometry.
        (geometry.attributes.position as { array: ArrayLike<number> }).array = data.position;
        if (data.serialized.index && geometry.index) (geometry.index as { array: ArrayLike<number> }).array = data.serialized.index;
        resolve(MeshBVH.deserialize(data.serialized, geometry, { setIndex: false }));
      };
      const request: BvhRequest = { index, position, options: plain, groups: [...geometry.groups] };
      const transfer = [position.buffer, ...(index ? [index.buffer] : [])].filter((b) => !(typeof SharedArrayBuffer !== 'undefined' && b instanceof SharedArrayBuffer));
      worker.postMessage(request, transfer as ArrayBuffer[]);
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}

/** A disc that is opaque in the middle and fades out towards its rim. */
function fadeTexture(): DataTexture {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot((x + 0.5) / size - 0.5, (y + 0.5) / size - 0.5) * 2;
      const t = Math.min(1, Math.max(0, (r - 0.22) / (0.92 - 0.22)));
      const value = Math.round((1 - t * t * (3 - 2 * t)) * 255);
      data.fill(value, (y * size + x) * 4, (y * size + x) * 4 + 4);
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat);
  texture.magFilter = texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

interface Prepared {
  /** What the scene was built from: all identical means the scene can be used again. */
  objects: DocState['objects'];
  order: DocState['order'];
  materials: DocState['materials'];
  textures: DocState['textures'];
  hidden: string;
  built: ThreeScene;
  bounds: Box3;
  sphere: Sphere;
  ground: Mesh<CircleGeometry, MeshStandardMaterial> | null;
  /** Whether the path tracer has this scene, with or without its ground. */
  loaded: 'with-ground' | 'without-ground' | null;
}

type PathTracer = WebGLPathTracer & { isCompiling: boolean; _pathTracer: { _blendTargets: WebGLRenderTarget[]; alpha: boolean; material: { backgroundAlpha: number } } };

export class RenderSession {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly tracer: PathTracer;
  private readonly bvh = new BvhBuilder();
  private readonly output = new OutputMaterial();
  private readonly quad = new FullScreenQuad(this.output);
  private readonly fade = fadeTexture();
  private prepared: Prepared | null = null;
  private environment: { key: string; texture: DataTexture } | null = null;
  private contextLost = false;
  disposed = false;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.contextLost = true;
    });
    this.renderer = new WebGLRenderer({ canvas: this.canvas, alpha: true, premultipliedAlpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.toneMapping = NoToneMapping;
    this.renderer.setClearColor(0x000000, 0);
    // The library announces on every construction that its WebGL tracer will be replaced by a WebGPU one some day.
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      if (!/deprecated/i.test(String(args[0]))) warn(...args);
    };
    try {
      this.tracer = new WebGLPathTracer(this.renderer) as PathTracer;
    } finally {
      console.warn = warn;
    }
    const tracer = this.tracer;
    tracer.setBVHWorker(this.bvh);
    tracer.renderToCanvas = false;
    tracer.rasterizeScene = false;
    tracer.dynamicLowRes = false;
    tracer.renderDelay = 0;
    tracer.minSamples = 0;
    tracer.fadeDuration = 0;
    tracer.filterGlossyFactor = 0.5;
    tracer.multipleImportanceSampling = true;
  }

  private get gl(): WebGL2RenderingContext {
    return this.renderer.getContext() as WebGL2RenderingContext;
  }

  private checkContext(): void {
    if (this.contextLost || this.gl.isContextLost()) {
      throw new Error('Rendering failed: the graphics card ran out of memory or was reset. Try a smaller image size (width / height).');
    }
  }

  /** The three.js scene for the document, built once per document state and set of hidden objects. */
  private async prepare(state: DocState, hideIds: readonly string[], control: RenderControl): Promise<Prepared> {
    const hidden = [...hideIds].sort().join('\n');
    const p = this.prepared;
    if (p && p.objects === state.objects && p.order === state.order && p.materials === state.materials && p.textures === state.textures && p.hidden === hidden) return p;
    this.dropScene();
    const hide = new Set(hideIds);
    const items = collectItems(
      state,
      state.order.filter((id) => !hide.has(id)),
    );
    if (items.length === 0) throw new Error('Nothing to render: the document has no visible objects with faces (after hideIds).');
    let last = performance.now();
    const built = await buildThreeScene(state, items, {
      v: 'up',
      emissive: 'intensity',
      doubleSided: true,
      groups: false,
      pause: async () => {
        if (control.cancelled) throw new Error(control.cancelled);
        if (performance.now() - last < 12) return;
        await tick();
        last = performance.now();
      },
    });
    const bounds = new Box3().setFromObject(built.scene);
    this.prepared = { objects: state.objects, order: state.order, materials: state.materials, textures: state.textures, hidden, built, bounds, sphere: bounds.getBoundingSphere(new Sphere()), ground: null, loaded: null };
    return this.prepared;
  }

  private dropScene(): void {
    const p = this.prepared;
    if (!p) return;
    p.ground?.geometry.dispose();
    p.ground?.material.dispose();
    p.built.dispose();
    this.prepared = null;
  }

  /** Adds, updates or removes the ground plane. */
  private syncGround(p: Prepared, ground: RenderSettings['ground']): void {
    if (ground.type === 'none') {
      p.ground?.removeFromParent();
      return;
    }
    if (!p.ground) {
      const radius = Math.max(p.sphere.radius, 1e-3);
      const material = new MeshStandardMaterial({ side: FrontSide, metalness: 0, transparent: true, alphaMap: this.fade });
      p.ground = new Mesh(new CircleGeometry(radius * 9, 96).rotateX(-Math.PI / 2), material);
      // A hair below the lowest point: faces lying exactly in the ground would fight with it for every ray.
      p.ground.position.set(p.sphere.center.x, p.bounds.min.y - radius * 2e-4, p.sphere.center.z);
    }
    if (!p.ground.parent) p.built.scene.add(p.ground);
    p.ground.updateMatrixWorld(true);
    p.ground.material.color.set(ground.color);
    // Reflectivity 1 is a polished floor, not a perfect mirror.
    p.ground.material.roughness = 1 - 0.92 * ground.reflectivity;
  }

  private syncEnvironment(settings: RenderSettings): Texture {
    const sun = settings.sun.enabled && settings.sun.intensity > 0 ? settings.sun : { ...settings.sun, enabled: false, azimuth: 0, elevation: 0, intensity: 0, softness: 1 };
    const key = JSON.stringify([settings.environment, sun]);
    if (this.environment?.key !== key) {
      this.environment?.texture.dispose();
      const image = buildEnvironment(settings.environment, sun);
      const half = new Uint16Array(image.data.length);
      for (let i = 0; i < half.length; i++) half[i] = DataUtils.toHalfFloat(image.data[i]);
      const texture = new DataTexture(half, image.width, image.height, RGBAFormat, HalfFloatType);
      texture.mapping = EquirectangularReflectionMapping;
      texture.colorSpace = LinearSRGBColorSpace;
      texture.minFilter = texture.magFilter = LinearFilter;
      texture.wrapS = RepeatWrapping;
      texture.needsUpdate = true;
      this.environment = { key, texture };
    }
    return this.environment.texture;
  }

  /** The texture holding the light gathered so far. */
  private accumulated(): Texture {
    const inner = this.tracer._pathTracer;
    if (inner?.alpha && Array.isArray(inner._blendTargets)) {
      // With an alpha channel the tracer alternates between two targets; the one last completed is the picture.
      const complete = Math.floor(this.tracer.samples);
      return inner._blendTargets[complete % 2 === 1 ? 1 : 0].texture;
    }
    return this.tracer.target.texture;
  }

  /** Draws the picture as it is now to the canvas. */
  private present(settings: RenderSettings): number {
    const started = performance.now();
    const { width, height } = settings.output;
    this.output.update(this.accumulated(), width, height, settings, Math.max(1, Math.floor(this.tracer.samples)));
    this.renderer.setRenderTarget(null);
    this.renderer.setViewport(0, 0, width, height);
    this.renderer.clear();
    this.quad.render(this.renderer);
    return performance.now() - started;
  }

  /** Renders `job`; the finished picture is on the canvas afterwards. */
  async render(state: DocState, job: RenderJob, control: RenderControl): Promise<{ samples: number; seconds: number; converged: boolean }> {
    const started = performance.now();
    const { settings } = job;
    const { width, height, samples: targetSamples, maxSeconds } = settings.output;
    const seconds = () => (performance.now() - started) / 1000;
    const report = (phase: RenderProgress['phase']) => control.onProgress({ phase, samples: Math.min(targetSamples, Math.floor(this.tracer.samples)), targetSamples, seconds: seconds(), maxSeconds });
    const check = () => {
      if (control.cancelled) throw new Error(control.cancelled);
      this.checkContext();
    };
    const tracer = this.tracer;
    tracer.reset();
    control.onProgress({ phase: 'preparing', samples: 0, targetSamples, seconds: 0, maxSeconds });
    await tick();
    check();

    const p = await this.prepare(state, job.hideIds, control);
    check();
    this.syncGround(p, settings.ground);
    const scene = p.built.scene;
    scene.environment = this.syncEnvironment(settings);
    scene.environmentIntensity = 1;
    // The path-tracing shader is compiled once per combination of features, which takes up to a minute the
    // first time on a computer. So the features never change: there is always a background image (black and
    // see-through unless the environment is the background) and always a lens (a pinhole unless depth of field is on).
    const showEnvironment = settings.background.type === 'environment';
    scene.background = scene.environment;
    scene.backgroundIntensity = showEnvironment ? 1 : 0;
    await tick();
    check();

    const camera = new PhysicalCamera(job.camera.fov, width / height, 0.01, 1000);
    camera.position.set(...job.camera.position);
    camera.lookAt(new Vector3(...job.camera.target));
    if (settings.depthOfField.enabled) {
      camera.fStop = settings.depthOfField.fStop;
      camera.focusDistance = job.focusDistance;
    } else {
      camera.fStop = 1e7;
    }
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    this.renderer.setSize(width, height, false);
    tracer.bounces = settings.output.bounces;
    const loaded = p.ground?.parent ? 'with-ground' : 'without-ground';
    if (p.loaded !== loaded) {
      // All textures share one size on the GPU: the largest one, as far as memory allows.
      const textures = p.built.textures;
      let size = 256;
      for (const texture of textures) {
        const image = texture.image as { width: number; height: number };
        while (size < 4096 && size < Math.max(image.width, image.height)) size *= 2;
      }
      while (size > 256 && (textures.length + 1) * size * size * 4 > TEXTURE_BUDGET) size /= 2;
      tracer.textureSize.set(size, size);
      p.loaded = null;
      await tracer.setSceneAsync(scene, camera);
      p.loaded = loaded;
    } else {
      tracer.setCamera(camera);
      tracer.updateMaterials();
      tracer.updateEnvironment();
    }
    // Behind the model there is nothing (alpha 0) unless the environment is shown; the backdrop is laid under it at the end.
    tracer._pathTracer.material.backgroundAlpha = showEnvironment ? 1 : 0;
    check();

    // Small pieces of work per GPU job; the right size is found from how long they take.
    const aspect = width / height;
    const setTiles = (count: number) => {
      const n = Math.min(256, Math.max(1, Math.round(count)));
      const x = Math.max(1, Math.round(Math.sqrt(n * aspect)));
      tracer.tiles.set(x, Math.max(1, Math.ceil(n / x)));
    };
    setTiles((width * height) / 110000);
    const gl = this.gl;
    let lastPreview = 0;
    let previewCost = 0;
    let done = 0;
    let stalled = 0;
    /** GPU time of the tiles of the sample being computed, the first tile of the render left out (it warms things up). */
    let tileTime = 0;
    let tileCount = 0;
    let lastTile = 0;
    let first = true;
    /** The time budget is for computing samples: it starts when the first one can be computed. */
    let samplingStarted: number | null = null;
    report('preparing');
    for (;;) {
      const before = tracer.samples;
      const tileStarted = performance.now();
      tracer.renderSample();
      if (tracer.samples === before) {
        // The path-tracing shader is still being compiled: seconds, and up to a minute the very first time on a computer.
        if (seconds() > COMPILE_SECONDS) throw new Error('Rendering failed: the graphics driver did not finish compiling the renderer.');
        await tick(15);
        if (++stalled % 8 === 0) report(samplingStarted === null ? 'preparing' : 'rendering');
        check();
        // Compiling does not count against the time budget.
        if (samplingStarted !== null) samplingStarted += performance.now() - tileStarted;
        continue;
      }
      await gpuDone(gl, lastTile);
      check();
      lastTile = performance.now() - tileStarted;
      if (first) {
        // The first piece of work also makes the graphics driver finish the shader, which can take as long again
        // as compiling it. Only now does the clock of the time budget start.
        first = false;
        lastTile = 0;
        samplingStarted = performance.now();
        report('rendering');
      } else {
        tileTime += lastTile;
        tileCount++;
      }
      const complete = Math.floor(tracer.samples + 1e-6);
      if (complete === done) continue;
      done = complete;
      if (done === 1 && gl.getError() === gl.OUT_OF_MEMORY) {
        throw new Error(`Rendering failed: not enough graphics memory for a ${width} x ${height} image. Try a smaller size.`);
      }
      // A whole sample is done: adjust the tile size to the time its tiles took.
      // (Not after the first sample, which is slow for reasons of its own, and never by more than a factor of two at once.)
      if (tileCount > 0 && done > 1) {
        const perTile = tileTime / tileCount;
        const tiles = tracer.tiles.x * tracer.tiles.y;
        if (perTile > TILE_MS * 1.4 || perTile < TILE_MS * 0.6) setTiles(Math.min(tiles * 2, Math.max(tiles / 2, (tiles * perTile) / TILE_MS)));
      }
      tileTime = tileCount = 0;
      const now = performance.now();
      const finished = done >= targetSamples;
      if (finished || control.stop || (now - (samplingStarted ?? now)) / 1000 >= maxSeconds) {
        this.present(settings);
        await gpuDone(gl);
        check();
        report('rendering');
        return { samples: done, seconds: seconds(), converged: finished };
      }
      // The preview: often at first, then no more than a tenth of the time is spent on it.
      if (now - lastPreview > Math.max(PREVIEW_MS, previewCost * 10)) {
        const cpu = this.present(settings);
        const t = performance.now();
        await gpuDone(gl);
        previewCost = cpu + (performance.now() - t);
        lastPreview = performance.now();
      }
      report('rendering');
    }
  }

  /** The canvas as an encoded image, base64 without a data: prefix. */
  async encode(mimeType: string, quality: number): Promise<string> {
    const blob = await new Promise<Blob | null>((resolve) => this.canvas.toBlob(resolve, mimeType, quality));
    if (!blob || blob.type !== mimeType) throw new Error(`The rendered image could not be encoded as ${mimeType}`);
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('The rendered image could not be encoded'));
      reader.readAsDataURL(blob);
    });
    return url.slice(url.indexOf(',') + 1);
  }

  /** Counts of what the renderer holds on the GPU, for leak checks. */
  stats() {
    return { ...this.renderer.info.memory, programs: this.renderer.info.programs?.length ?? 0 };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dropScene();
    this.environment?.texture.dispose();
    this.fade.dispose();
    this.quad.dispose();
    this.output.dispose();
    this.bvh.dispose();
    this.tracer.dispose();
    this.renderer.dispose();
    // Give the context back now instead of when the garbage collector gets to the canvas.
    this.renderer.forceContextLoss();
    this.canvas.width = this.canvas.height = 1;
  }
}
