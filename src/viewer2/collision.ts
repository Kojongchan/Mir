import type { BufferAttribute, BufferGeometry, InterleavedBufferAttribute } from 'three';
import { MeshBVH, type MeshBVHOptions, type SerializedBVH } from 'three-mesh-bvh';
import type { BuildRequest, BuildResult } from './collision.worker';

/**
 * Bounding volume hierarchies of the tile geometries walk mode casts rays against (TilesViewer.walkCast), built in a
 * worker (collision.worker.ts), the nearest first. Built on the main thread when a ray first came near a tile, each
 * took 27–582 ms and the picture stood still: 9 stops over 20 m of the tunnel PD-2-1 (user report "캐릭터를 움직이면
 * 렉이 걸리면서 화면이 끊겨보임"). A geometry whose hierarchy is not there yet is skipped by the rays — the walk holds
 * still meanwhile (TilesViewer) rather than fall through a floor not yet indexed.
 *
 * The position and index arrays are lent to the worker and come back with the hierarchy: copies of 2–12 MB a tile cost
 * a 30–55 ms pause every few tiles (collecting the garbage). Meanwhile the GPU draws from what it was given, so only a
 * geometry already drawn is to be asked for (TilesViewer.indexAround), and nothing here reads it until it is back.
 */
export class CollisionIndex {
  private readonly built = new WeakMap<BufferGeometry, MeshBVH>();
  /** Wanted now, nearest first (replaced each walk frame: geometries no longer near or on screen drop out). */
  private wanted: BufferGeometry[] = [];
  private readonly jobs = new Map<number, BufferGeometry>();
  private readonly failed = new WeakSet<BufferGeometry>();
  /** Lent to a worker that died: its arrays are gone, it is passed by (never indexed). */
  private readonly lost = new WeakSet<BufferGeometry>();
  private worker: Worker | null = null;
  private next = 0;

  get(geometry: BufferGeometry): MeshBVH | undefined {
    const bvh = this.built.get(geometry);
    if (bvh || !this.failed.has(geometry)) return bvh;
    // The worker could not build it: here, once (the stop the worker avoids, but no hole in the floor).
    const built = new MeshBVH(geometry, INDIRECT);
    this.built.set(geometry, built);
    return built;
  }

  /** Whether a geometry's hierarchy is built. */
  has(geometry: BufferGeometry): boolean { return this.built.has(geometry); }

  /** Whether a geometry will never be indexed (its arrays went with a worker that died). */
  gone(geometry: BufferGeometry): boolean { return this.lost.has(geometry); }

  /** Geometries to index, nearest first; the ones already built or under way are left out. */
  want(geometries: BufferGeometry[]): void {
    const busy = new Set(this.jobs.values());
    this.wanted = geometries.filter(g => !this.built.has(g) && !busy.has(g) && !this.failed.has(g) && !this.lost.has(g));
    this.pump();
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.jobs.clear();
    this.wanted = [];
  }

  /** One geometry at a time in the worker (the nearest wanted), so a nearer one asked for later goes next. */
  private pump() {
    if (this.jobs.size || !this.wanted.length) return;
    const geometry = this.wanted.shift()!;
    const position = geometry.getAttribute('position') as BufferAttribute | InterleavedBufferAttribute;
    const index = geometry.getIndex();
    const interleaved = 'isInterleavedBufferAttribute' in position && position.isInterleavedBufferAttribute;
    const id = this.next++;
    if (!geometry.boundingSphere) geometry.computeBoundingSphere(); // (culling reads it while the arrays are away)
    // Lent, unless they are views into a larger buffer (shared with other data): copied then.
    const lend = <T extends ArrayBufferView>(a: T): T => (a.byteOffset === 0 && a.byteLength === a.buffer.byteLength ? a : (a as unknown as Uint8Array).slice() as unknown as T);
    const request: BuildRequest = {
      id, interleaved, normalized: position.normalized,
      array: lend((interleaved ? (position as InterleavedBufferAttribute).data.array : (position as BufferAttribute).array) as BuildRequest['array']),
      stride: interleaved ? (position as InterleavedBufferAttribute).data.stride : 3,
      offset: interleaved ? (position as InterleavedBufferAttribute).offset : 0,
      index: index ? lend(index.array as Uint16Array | Uint32Array) : null,
    };
    this.jobs.set(id, geometry);
    this.ensureWorker().postMessage(request, [request.array.buffer, ...(request.index ? [request.index.buffer] : [])]);
  }

  /** The arrays back where they were lent from (a copy coming back is not put in: the geometry kept its own). */
  private giveBack(geometry: BufferGeometry, array: BuildRequest['array'], index: BuildRequest['index']) {
    const position = geometry.getAttribute('position') as BufferAttribute | InterleavedBufferAttribute;
    const holder = 'isInterleavedBufferAttribute' in position && position.isInterleavedBufferAttribute ? position.data : position as BufferAttribute;
    if (holder.array.byteLength === 0) holder.array = array;
    const own = geometry.getIndex();
    if (own && index && own.array.byteLength === 0) own.array = index;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./collision.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }: MessageEvent<BuildResult>) => {
      const geometry = this.jobs.get(data.id);
      this.jobs.delete(data.id);
      if (geometry) {
        this.giveBack(geometry, data.array, data.index);
        if ('error' in data) this.failed.add(geometry);
        else {
          const serialized = { roots: data.roots, index: null, indirectBuffer: data.indirectBuffer } as unknown as SerializedBVH;
          this.built.set(geometry, MeshBVH.deserialize(serialized, geometry, { setIndex: false }));
        }
      }
      this.pump();
    };
    worker.onerror = () => {
      // The worker is gone with what it was lent: that geometry is passed by from now; a new worker takes the rest.
      for (const geometry of this.jobs.values()) this.lost.add(geometry);
      this.jobs.clear();
      worker.terminate();
      this.worker = null;
      this.pump();
    };
    this.worker = worker;
    return worker;
  }
}

/** Indirect: the triangles are reordered through a separate buffer, not in the index the GPU draws from. */
const INDIRECT = { indirect: true } as MeshBVHOptions & { indirect: boolean };
