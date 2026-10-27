import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { decodeXer, encodeXer, parseXer, serializeXer, type XerDoc, type XerEncoding } from '../../lib/p6/xer';
import { readSchedule, type P6Schedule } from '../../lib/p6/schedule';
import { DAY, scheduleRange, startOfDay, timedActivities, type TimedActivity } from '../../lib/sim45d/timeline';
import type { BoqLine, QtyRow } from '../../lib/sim45d/types';
import { applyActuals, type ModelActuals } from '../../lib/sim45d/modelActuals';
import type { LinkSet } from '../../lib/sim45d/setup';
import type { ResolvedLinks } from '../../lib/sim45d/viewerLinks';
import type { SplitResult } from '../../lib/sim45d/qtySplit';

/**
 * 공정·공사비(4D/5D) 화면 상태: 공정표(XER), 기준일·재생, 작업 선택, 작업 ↔ 객체 연결, 작업별 공사비, 내역·물량.
 * 3D 뷰어 페이지(ThreeDTest2 의 sim 모드)가 들고, 하단 도크와 3D 색칠이 같은 상태를 본다.
 * 마지막으로 연 공정표는 이 브라우저에 보관(편의용 — 서버 저장은 0040 스키마에서).
 */
export type PlaySpeed = 1 | 7 | 30;
export const PLAY_SPEED_LABEL: Record<PlaySpeed, string> = { 1: '1일/초', 7: '1주/초', 30: '1개월/초' };

const storeKey = (projectId: string) => `mir.sim45d.xer.${projectId}`;
const MAX_STORED = 3_000_000; // 문자 수 — 넘으면 보관하지 않음(브라우저 저장 한도)

export interface Sim45d {
  schedule: P6Schedule | null;
  fileName: string;
  sourceEncoding: XerEncoding | null;
  error: string;
  acts: TimedActivity[];
  actsByCode: ReadonlyMap<string, TimedActivity>;
  range: { start: number; end: number } | null;
  time: number;
  setTime: (t: number) => void;
  playing: boolean;
  setPlaying: (on: boolean) => void;
  speed: PlaySpeed;
  setSpeed: (s: PlaySpeed) => void;
  selected: ReadonlySet<string>;
  selectActivity: (code: string, additive: boolean) => void;
  setSelected: (codes: ReadonlySet<string>) => void;
  /** 작업(Activity ID) → 화면 객체(dbId, 요소 노드). 3D 뷰어가 6단계 연결·모델 코드로 찾아 넣는다(lib/sim45d/viewerLinks.ts). */
  links: ReadonlyMap<string, readonly number[]>;
  setLinks: (r: ResolvedLinks | null) => void;
  /** 찾은 결과 요약(6단계 연결 중 화면 모델에서 찾은 것·못 찾은 것, 모델 코드로 이은 객체). */
  linkInfo: Omit<ResolvedLinks, 'byCode'> | null;
  /** 대상에 저장된 6단계 연결(단계 시트가 넣음). */
  savedLinks: LinkSet['links'];
  setSavedLinks: (links: LinkSet['links']) => void;
  /** 모델의 현장 실적(A5)을 공정표에 넣었으면 그 요약. */
  actualsInfo: { filled: number; dated: number; linked: number } | null;
  setModelActuals: (m: ModelActuals | null) => void;
  /** 작업 → 공사비(계약 기준) — 수량분개(lib/sim45d/qtySplit.ts)가 채운다. */
  cost: ReadonlyMap<string, number>;
  boq: BoqLine[];
  qty: QtyRow[];
  split: SplitResult | null;
  setSplit: (r: SplitResult | null) => void;
  setQty: (rows: QtyRow[]) => void;
  fourD: boolean;
  setFourD: (on: boolean) => void;
  hideFuture: boolean;
  setHideFuture: (on: boolean) => void;
  openXer: (file: File) => Promise<void>;
  downloadXer: (encoding: XerEncoding) => void;
  close: () => void;
}

export function useSim45d(projectId: string, enabled: boolean): Sim45d {
  const [doc, setDoc] = useState<XerDoc | null>(null);
  const [fileName, setFileName] = useState('');
  const [sourceEncoding, setSourceEncoding] = useState<XerEncoding | null>(null);
  const [error, setError] = useState('');
  const [time, setTimeState] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaySpeed>(7);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [fourD, setFourD] = useState(true);
  const [hideFuture, setHideFuture] = useState(true);
  const [resolved, setResolved] = useState<ResolvedLinks | null>(null);
  const [savedLinks, setSavedLinks] = useState<LinkSet['links']>([]);
  const [modelActuals, setModelActuals] = useState<ModelActuals | null>(null);
  // 공사비·5D 내역은 수량분개(단계 시트가 계산해 넣음), 물량 대사는 모델 수량과 비교한 것.
  const [split, setSplit] = useState<SplitResult | null>(null);
  const [qty, setQty] = useState<QtyRow[]>([]);
  const cost = useMemo<ReadonlyMap<string, number>>(() => split?.byCode ?? new Map(), [split]);
  const boq = useMemo<BoqLine[]>(() => (split?.lines ?? []).filter(l => l.status !== 'not-target').map(l => ({
    id: l.id, path: l.row?.path?.length ? l.row.path : ['(집계표에 없는 항목)'], name: l.name, spec: l.spec, unit: l.unit,
    qty: l.targetQty, unitPrice: l.unitPrice, amount: l.targetAmount, boqQty: l.qty, basis: l.basis,
    activity: l.alloc.length === 1 ? l.alloc[0].code : l.alloc.length ? `${l.alloc.length}개 작업` : l.status === 'unmatched' ? '못 맞춤' : '배분 안 됨',
  })), [split]);
  const links = useMemo<ReadonlyMap<string, readonly number[]>>(() => resolved?.byCode ?? new Map(), [resolved]);
  const linkInfo = useMemo(() => (resolved ? { found: resolved.found, missing: resolved.missing, byModelCode: resolved.byModelCode } : null), [resolved]);
  const setLinks = useCallback((r: ResolvedLinks | null) => setResolved(r), []);

  const withActuals = useMemo(() => {
    if (!doc) return null;
    try { return applyActuals(readSchedule(doc), modelActuals); } catch { return null; }
  }, [doc, modelActuals]);
  const schedule = withActuals?.schedule ?? null;
  const actualsInfo = useMemo(() => (withActuals && modelActuals && withActuals.filled
    ? { filled: withActuals.filled, dated: modelActuals.dated, linked: modelActuals.linked } : null), [withActuals, modelActuals]);
  const acts = useMemo(() => (schedule ? timedActivities(schedule) : []), [schedule]);
  const actsByCode = useMemo(() => new Map(acts.map(a => [a.code, a])), [acts]);
  const range = useMemo(() => scheduleRange(acts), [acts]);

  const load = useCallback((text: string, name: string, encoding: XerEncoding) => {
    const parsed = parseXer(text);
    const s = readSchedule(parsed); // 프로젝트가 없으면 여기서 오류
    setDoc(parsed);
    setFileName(name);
    setSourceEncoding(encoding);
    setError('');
    setSelected(new Set());
    setModelActuals(null); // 이 공정표용 실적은 단계 시트가 다시 넣는다
    setTimeState(defaultTime(s));
  }, []);

  // 이 브라우저에 보관한 마지막 공정표
  useEffect(() => {
    if (!enabled || !projectId) return;
    try {
      const raw = localStorage.getItem(storeKey(projectId));
      if (!raw) return;
      const saved = JSON.parse(raw) as { name: string; encoding: XerEncoding; text: string };
      load(saved.text, saved.name, saved.encoding);
    } catch { /* 저장본이 없거나 깨짐 */ }
  }, [enabled, projectId, load]);

  const openXer = useCallback(async (file: File) => {
    try {
      const { text, encoding } = decodeXer(new Uint8Array(await file.arrayBuffer()));
      load(text, file.name, encoding);
      try {
        if (text.length <= MAX_STORED) localStorage.setItem(storeKey(projectId), JSON.stringify({ name: file.name, encoding, text }));
        else localStorage.removeItem(storeKey(projectId));
      } catch { /* 저장 공간 부족·비공개 창 */ }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [load, projectId]);

  const downloadXer = useCallback((encoding: XerEncoding) => {
    if (!doc) return;
    const bytes = encodeXer(serializeXer(doc), encoding);
    const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = (fileName.replace(/\.xer$/i, '') || 'schedule') + (encoding === 'utf-8' ? '_utf8' : '') + '.xer';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [doc, fileName]);

  const close = useCallback(() => {
    setDoc(null); setFileName(''); setSourceEncoding(null); setPlaying(false); setSelected(new Set());
    try { localStorage.removeItem(storeKey(projectId)); } catch { /* 비공개 창 */ }
  }, [projectId]);

  const setTime = useCallback((t: number) => setTimeState(t), []);

  // 재생: 0.1초마다 speed/10 일씩
  const rangeRef = useRef(range);
  rangeRef.current = range;
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      const r = rangeRef.current;
      if (!r) return;
      setTimeState(t => {
        const next = t + (speed * DAY) / 10;
        if (next >= r.end) { setPlaying(false); return r.end; }
        return next;
      });
    }, 100);
    return () => window.clearInterval(id);
  }, [playing, speed]);

  const selectActivity = useCallback((code: string, additive: boolean) => {
    setSelected(prev => {
      if (!additive) return prev.size === 1 && prev.has(code) ? new Set() : new Set([code]);
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  }, []);

  // 모델 실적이 들어오면 기준일을 데이터 기준일(가장 늦은 실적)로 — 실적이 바뀔 때 한 번.
  const timedFor = useRef<object | null>(null);
  useEffect(() => {
    if (!schedule || !modelActuals || timedFor.current === modelActuals) return;
    timedFor.current = modelActuals;
    setTimeState(defaultTime(schedule));
  }, [schedule, modelActuals]);

  return {
    schedule, fileName, sourceEncoding, error, acts, actsByCode, range, time, setTime, playing, setPlaying, speed, setSpeed,
    selected, selectActivity, setSelected, links, setLinks, linkInfo, savedLinks, setSavedLinks, actualsInfo, setModelActuals,
    cost, boq, qty, split, setSplit, setQty, fourD, setFourD, hideFuture, setHideFuture, openXer, downloadXer, close,
  };
}

/**
 * 처음 기준일: 공정표의 데이터 기준일(실적을 넣었으면 가장 늦은 실적일)이 기간 안이면 그날, 아니면 오늘이 기간 안이면 오늘,
 * 둘 다 아니면 기간의 35% 지점(계획만 있는 먼 공정표).
 */
export function defaultTime(s: P6Schedule): number {
  const r = scheduleRange(timedActivities(s));
  if (!r) return 0;
  const inRange = (t: number | null): t is number => t !== null && Number.isFinite(t) && t > r.start && t <= r.end;
  const data = s.dataDate ? Date.parse(s.dataDate.slice(0, 10)) : null, today = startOfDay(Date.now());
  if (inRange(data)) return startOfDay(data);
  if (inRange(today)) return today;
  return startOfDay(r.start + (r.end - r.start) * 0.35);
}
