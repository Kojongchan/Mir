import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { errMessage, readApiJson } from '../lib/errors';
import { ModelTree, type TreeData } from './ModelTree';
import type { ObjectProps } from '../components/model/PropertyPanel';

/** Model index from the cache state (`meta`): tree URL and property shards (scripts/build-meta-index.mjs). */
export type MetaInfo = { tree: string; shardSize: number; shardCount: number; objects?: number; alias?: string };
type Pending = { query: string; key: string; onProgress: (done: number, total: number) => void; resolve: (ids: number[]) => void; reject: (e: Error) => void };
type Shard = Record<string, ObjectProps>;
type MetaState = {
  urn: string; shardSize: number; shardCount: number;
  /** Parsed shards in memory (the most recent PARSED_KEPT), and shards known to be in the browser cache. */
  shards: Map<number, Promise<Shard>>; stored: Set<number>;
  cache: Promise<Cache | null>;
  urls: { at: number; list: Promise<string[]> } | null;
  prefetching: boolean;
};

const authHeaders = async () => {
  const { data } = await supabase.auth.getSession();
  return { authorization: `Bearer ${data.session?.access_token ?? ''}` };
};

/** Shard URLs are signed for an hour (api/aps-convert.ts); sign again 10 minutes before. */
const URLS_FOR_MS = 50 * 60_000;
const PARSED_KEPT = 48;
const PREFETCH_JOBS = 2;

/**
 * Property shards kept in this browser (Cache Storage), one cache per model, cleared when its index is rebuilt (the
 * index generation is in the signed tree URL: …/<model>/meta/runs/<gen>/tree.json). Signed URLs change every session,
 * so the HTTP cache never hits.
 */
const PROPS_MARKER = 'https://props-cache.mir.invalid/__gen';
const propsKey = (k: number) => `https://props-cache.mir.invalid/p/${k}`;
function openPropsCache(treeUrl: string): Promise<Cache | null> {
  const m = /\/([A-Za-z0-9]{1,40})\/meta\/(runs\/[A-Za-z0-9-]+)\/tree\.json(?:\?|$)/.exec(treeUrl);
  if (!m || typeof caches === 'undefined') return Promise.resolve(null);
  const [, model, gen] = m;
  return (async () => {
    try {
      const name = `mir-props:${model}`;
      let cache = await caches.open(name);
      const marker = await cache.match(PROPS_MARKER);
      const current = marker && (await marker.text()) === gen;
      if (marker && !current) { await caches.delete(name); cache = await caches.open(name); }
      if (!current) await cache.put(PROPS_MARKER, new Response(gen));
      return cache;
    } catch { return null; } // storage blocked (private mode, quota)
  })();
}

/**
 * Model tree, per-object properties and property-value search (a worker loads every shard once) for the open model.
 * Properties come in shards of 1,024 objects. A click used to wait for one API call (sign) and one download per new
 * shard of the object and of each of its parents; now the shard URLs are signed once per hour, shards stay in this
 * browser across visits, and `prefetch` downloads the rest in the background once the 3D view has settled, so a
 * click finds its shards locally (≈8 MB compressed for a 250,000-object model).
 */
export function useModelIndex() {
  const [tree, setTree] = useState<ModelTree | null>(null);
  const [note, setNote] = useState('');
  const metaRef = useRef<MetaState | null>(null);
  const searchRef = useRef<{ worker: Worker; seq: number; urls?: { key: string; at: number; list: Promise<string[]> }; pending: Map<number, Pending> } | null>(null);
  useEffect(() => () => { searchRef.current?.worker.terminate(); searchRef.current = null; }, []);

  const reset = useCallback(() => { metaRef.current = null; setTree(null); setNote(''); }, []);

  const open = useCallback(async (urn: string, meta: MetaInfo | undefined) => {
    if (!meta) { setNote('이 모델은 아직 모델 트리·속성 색인이 없습니다.'); return; }
    const state: MetaState = { urn, shardSize: meta.shardSize, shardCount: meta.shardCount, shards: new Map(), stored: new Set(),
      cache: openPropsCache(meta.tree), urls: null, prefetching: false };
    metaRef.current = state;
    setNote('모델 트리 불러오는 중…');
    try {
      const r = await fetch(meta.tree);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const next = new ModelTree(await r.json() as TreeData);
      if (metaRef.current !== state) return;
      setTree(next); setNote('');
    } catch (e) { if (metaRef.current === state) setNote(`모델 트리를 불러오지 못했습니다: ${errMessage(e)}`); }
  }, []);

  /** Every shard's signed URL (one API call per hour). */
  const shardUrls = useCallback((state: MetaState, renew = false): Promise<string[]> => {
    if (!renew && state.urls && Date.now() - state.urls.at < URLS_FOR_MS) return state.urls.list;
    const list = (async () => {
      const r = await fetch(`/api/aps-convert?urn=${encodeURIComponent(state.urn)}&metaShards=all`, { headers: await authHeaders() });
      const j = await readApiJson<{ urls?: string[]; error?: string }>(r);
      if (!r.ok || !j.urls) throw new Error(j.error ?? '속성 조회 실패');
      return j.urls;
    })();
    const entry = { at: Date.now(), list };
    state.urls = entry;
    list.catch(() => { if (state.urls === entry) state.urls = null; });
    return list;
  }, []);

  /** Shard k from this browser's cache, else downloaded (and kept). `parse` false: only make sure it is cached. */
  const fetchShard = useCallback(async (state: MetaState, k: number, parse: boolean, priority: RequestPriority): Promise<Shard | null> => {
    const cache = await state.cache;
    const hit = cache && await cache.match(propsKey(k)).catch(() => undefined);
    if (hit) { state.stored.add(k); return parse ? hit.json() as Promise<Shard> : null; }
    let res = await fetch((await shardUrls(state))[k], { priority });
    if (res.status === 403) res = await fetch((await shardUrls(state, true))[k], { priority }); // signature expired
    if (res.status === 404) return {};
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (cache) cache.put(propsKey(k), res.clone()).then(() => { state.stored.add(k); }, () => {});
    return parse ? res.json() as Promise<Shard> : null;
  }, [shardUrls]);

  const loadProps = useCallback(async (dbId: number): Promise<ObjectProps | null> => {
    const state = metaRef.current;
    if (!state) return null;
    const k = Math.floor(dbId / state.shardSize);
    if (k < 0 || k >= state.shardCount) return null;
    let shard = state.shards.get(k);
    if (shard) { state.shards.delete(k); state.shards.set(k, shard); } // most recent last
    else {
      shard = fetchShard(state, k, true, 'high').then(s => s ?? {});
      state.shards.set(k, shard);
      shard.catch(() => state.shards.delete(k));
      while (state.shards.size > PARSED_KEPT) state.shards.delete(state.shards.keys().next().value!);
    }
    return (await shard)[dbId] ?? null;
  }, [fetchShard]);

  /**
   * Download every shard not yet in this browser, in the background (two at a time, low priority), so clicks do not
   * wait. Call once the 3D view has settled; skipped when the browser asks to save data.
   */
  const prefetch = useCallback(async () => {
    const state = metaRef.current;
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
    if (!state || state.prefetching || saveData || !(await state.cache)) return;
    state.prefetching = true;
    let next = 0;
    await Promise.all(Array.from({ length: PREFETCH_JOBS }, async () => {
      for (let k = next++; k < state.shardCount; k = next++) {
        if (metaRef.current !== state) return; // another model opened
        if (state.stored.has(k)) continue;
        try { await fetchShard(state, k, false, 'low'); } catch { /* a click fetches it again */ }
      }
    }));
  }, [fetchShard]);

  const searchValues = useCallback((query: string, onProgress: (done: number, total: number) => void) => {
    const meta = metaRef.current;
    if (!meta) return Promise.resolve([] as number[]);
    let w = searchRef.current;
    if (!w) {
      const worker = new Worker(new URL('./propSearch.worker.ts', import.meta.url), { type: 'module' });
      const state: NonNullable<typeof searchRef.current> = { worker, seq: 0, pending: new Map() };
      worker.onmessage = async (e: MessageEvent<{ type: string; seq?: number; ids?: number[]; done?: number; total?: number; message?: string }>) => {
        const msg = e.data;
        if (msg.type === 'progress') { for (const p of state.pending.values()) p.onProgress(msg.done ?? 0, msg.total ?? 0); return; }
        const p = msg.seq === undefined ? undefined : state.pending.get(msg.seq);
        if (!p) return;
        if (msg.type === 'need-urls') {
          try {
            if (state.urls?.key !== p.key || Date.now() - state.urls.at > 10 * 60_000) {
              const list = (async () => {
                const r = await fetch(`/api/aps-convert?urn=${encodeURIComponent(p.key)}&metaShards=all`, { headers: await authHeaders() });
                const j = await readApiJson<{ urls?: string[]; error?: string }>(r);
                if (!r.ok || !j.urls) throw new Error(j.error ?? '속성 색인 조회 실패');
                return j.urls;
              })();
              state.urls = { key: p.key, at: Date.now(), list };
              list.catch(() => { if (state.urls?.list === list) state.urls = undefined; });
            }
            worker.postMessage({ type: 'search', key: p.key, urls: await state.urls.list, query: p.query, seq: msg.seq });
          } catch (err) { state.pending.delete(msg.seq!); p.reject(err as Error); }
          return;
        }
        state.pending.delete(msg.seq!);
        if (msg.type === 'result') p.resolve(msg.ids ?? []);
        else p.reject(new Error(msg.message ?? '검색 실패'));
      };
      worker.onerror = e => {
        for (const p of state.pending.values()) p.reject(new Error(e.message || '검색 작업자 오류'));
        state.pending.clear();
      };
      searchRef.current = w = state;
    }
    const seq = ++w.seq;
    return new Promise<number[]>((resolve, reject) => {
      w!.pending.set(seq, { query, key: meta.urn, onProgress, resolve, reject });
      w!.worker.postMessage({ type: 'search', key: meta.urn, query, seq });
    });
  }, []);

  return { tree, note, open, reset, loadProps, searchValues, prefetch };
}
