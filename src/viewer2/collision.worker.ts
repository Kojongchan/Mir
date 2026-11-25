/// <reference lib="webworker" />
// Bounding volume hierarchies for walk mode's rays (collision.ts), built off the main thread: a tile geometry's
// positions (its interleaved quantized buffer) and index are lent here and go back with the hierarchy's nodes, also
// when it fails. Indirect, so the index keeps its order (the GPU draws from it).
import { BufferAttribute, BufferGeometry, InterleavedBuffer, InterleavedBufferAttribute } from 'three';
import { MeshBVH, type MeshBVHOptions, type SerializedBVH } from 'three-mesh-bvh';

export type BuildRequest = {
  id: number;
  /** The position data: an interleaved buffer (stride, offset) or a plain one (stride = 3, offset 0). */
  array: Float32Array | Int16Array | Uint16Array | Int8Array | Uint8Array;
  stride: number; offset: number; normalized: boolean; interleaved: boolean;
  index: Uint16Array | Uint32Array | null;
};
export type BuildResult = { id: number; array: BuildRequest['array']; index: BuildRequest['index'] }
  & ({ roots: ArrayBuffer[]; indirectBuffer: Uint32Array | Uint16Array | null } | { error: string });

onmessage = ({ data }: MessageEvent<BuildRequest>) => {
  const { id, array, stride, offset, normalized, interleaved, index } = data;
  try {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', interleaved
      ? new InterleavedBufferAttribute(new InterleavedBuffer(array, stride), 3, offset, normalized)
      : new BufferAttribute(array, 3, normalized));
    if (index) geometry.setIndex(new BufferAttribute(index, 1));
    const options: MeshBVHOptions & { indirect: boolean } = { indirect: true }; // (not in the library's typings)
    const bvh = new MeshBVH(geometry, options);
    const { roots, indirectBuffer } = MeshBVH.serialize(bvh, { cloneBuffers: false }) as SerializedBVH & { indirectBuffer: Uint32Array | Uint16Array | null };
    const message: BuildResult = { id, array, index, roots, indirectBuffer };
    postMessage(message, [array.buffer, ...(index ? [index.buffer] : []), ...roots, ...(indirectBuffer ? [indirectBuffer.buffer] : [])]);
  } catch (e) {
    const message: BuildResult = { id, array, index, error: e instanceof Error ? e.message : String(e) };
    postMessage(message, [array.buffer, ...(index ? [index.buffer] : [])]);
  }
};
