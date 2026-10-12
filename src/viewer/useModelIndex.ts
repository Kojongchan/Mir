import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { errMessage, readApiJson } from '../lib/errors';
import { ModelTree, type TreeData } from './ModelTree';
import type { ObjectProps } from '../components/model/PropertyPanel';

/** Model index from the cache state (`meta`): tree URL and property shards (scripts/build-meta-index.mjs). */
export type MetaInfo = { tree: string; shardSize: number; shardCount: number; objects?: number; alias?: string };
type Pending = { query: string; key: string; onProgress: (done: number, total: number) => void; resolve: (ids: number[]) => void; reject: (e: Error) => void };

const authHeaders = async () => {
  const { data } = await supabase.auth.getSession();
  return { authorization: `Bearer ${data.session?.access_token ?? ''}` };
};

/**
 * Model tree, per-object properties (one shard per 1,024 objects, fetched on demand) and property-value search
 * (a worker loads every shard once) for the open model. Shared by the 3D pages that show the tree/property panels.
 */
export function useModelIndex() {
  const [tree, setTree] = useState<ModelTree | null>(null);
  const [note, setNote] = useState('');
  const metaRef = useRef<{ urn: string; shardSize: number; shardCount: number; shards: Map<number, Promise<Record<string, ObjectProps>>> } | null>(null);
  const searchRef = useRef<{ worker: Worker; seq: number; urls?: { key: string; at: number; list: Promise<string[]> }; pending: Map<number, Pending> } | null>(null);
  useEffect(() => () => { searchRef.current?.worker.terminate(); searchRef.current = null; }, []);

  const reset = useCallback(() => { metaRef.current = null; setTree(null); setNote(''); }, []);

  const open = useCallback(async (urn: string, meta: MetaInfo | undefined) => {
    if (!meta) { setNote('이 모델은 아직 모델 트리·속성 색인이 없습니다.'); return; }
    metaRef.current = { urn, shardSize: meta.shardSize, shardCount: meta.shardCount, shards: new Map() };
    setNote('모델 트리 불러오는 중…');
    try {
      const r = await fetch(meta.tree);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const next = new ModelTree(await r.json() as TreeData);
      if (metaRef.current?.urn !== urn) return;
      setTree(next); setNote('');
    } catch (e) { if (metaRef.current?.urn === urn) setNote(`모델 트리를 불러오지 못했습니다: ${errMessage(e)}`); }
  }, []);

  const loadProps = useCallback(async (dbId: number): Promise<ObjectProps | null> => {
    const meta = metaRef.current;
    if (!meta) return null;
    const k = Math.floor(dbId / meta.shardSize);
    if (k < 0 || k >= meta.shardCount) return null;
    let shard = meta.shards.get(k);
    if (!shard) {
      shard = (async () => {
        const r = await fetch(`/api/aps-convert?urn=${encodeURIComponent(meta.urn)}&metaShard=${k}`, { headers: await authHeaders() });
        const j = await readApiJson<{ url?: string; error?: string }>(r);
        if (!r.ok || !j.url) throw new Error(j.error ?? '속성 조회 실패');
        const res = await fetch(j.url);
        if (res.status === 404) return {};
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<Record<string, ObjectProps>>;
      })();
      meta.shards.set(k, shard);
      shard.catch(() => meta.shards.delete(k));
    }
    return (await shard)[dbId] ?? null;
  }, []);

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

  return { tree, note, open, reset, loadProps, searchValues };
}
