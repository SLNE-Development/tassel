// Builds the ray-tracing acceleration structure (BVH) of a render's geometry off the main thread.
// The other side is `BvhBuilder` in bvh.ts; the protocol is the one three-mesh-bvh's own worker uses.
import { BufferAttribute, BufferGeometry } from 'three';
import { MeshBVH, type MeshBVHOptions } from 'three-mesh-bvh';

export interface BvhRequest {
  index: Uint32Array | Uint16Array | null;
  position: Float32Array;
  options: MeshBVHOptions;
  groups: { start: number; count: number; materialIndex?: number }[];
}

export type BvhReply = { error: string } | { error: null; serialized: ReturnType<typeof MeshBVH.serialize>; position: Float32Array };

self.onmessage = ({ data }: MessageEvent<BvhRequest>) => {
  const post = (message: BvhReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(message, transfer);
  try {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(data.position, 3, false));
    if (data.index) geometry.setIndex(new BufferAttribute(data.index, 1, false));
    for (const group of data.groups) geometry.addGroup(group.start, group.count, group.materialIndex);
    const bvh = new MeshBVH(geometry, data.options);
    const serialized = MeshBVH.serialize(bvh, { cloneBuffers: false });
    const transfer = new Set<Transferable>([data.position.buffer as ArrayBuffer, ...(serialized.roots as ArrayBuffer[])]);
    if (serialized.index) transfer.add(serialized.index.buffer as ArrayBuffer);
    const indirect = (serialized as { indirectBuffer?: ArrayBufferView | null }).indirectBuffer;
    if (indirect) transfer.add(indirect.buffer as ArrayBuffer);
    post({ error: null, serialized, position: data.position }, [...transfer]);
  } catch (error) {
    post({ error: error instanceof Error ? error.message : String(error) });
  }
};
