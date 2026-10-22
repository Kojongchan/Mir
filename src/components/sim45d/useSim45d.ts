import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { decodeXer, encodeXer, parseXer, serializeXer, type XerDoc, type XerEncoding } from '../../lib/p6/xer';
import { readSchedule, type P6Schedule } from '../../lib/p6/schedule';
import { DAY, scheduleRange, startOfDay, timedActivities, type TimedActivity } from '../../lib/sim45d/timeline';
import type { BoqLine, QtyRow } from '../../lib/sim45d/types';

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
  /** 작업(Activity ID) → 객체(dbId). */
  links: ReadonlyMap<string, readonly number[]>;
  /** 작업 → 공사비(계약 기준). */
  cost: ReadonlyMap<string, number>;
  boq: BoqLine[];
  qty: QtyRow[];
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
  // 연결·공사비·내역·물량은 자료 파서·연결 엔진이 채운다(다음 단계).
  const [links] = useState<ReadonlyMap<string, readonly number[]>>(new Map());
  const [cost] = useState<ReadonlyMap<string, number>>(new Map());
  const [boq] = useState<BoqLine[]>([]);
  const [qty] = useState<QtyRow[]>([]);

  const schedule = useMemo(() => {
    if (!doc) return null;
    try { return readSchedule(doc); } catch { return null; }
  }, [doc]);
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
    const r = scheduleRange(timedActivities(s));
    setTimeState(r ? startOfDay(r.start + (r.end - r.start) * 0.35) : 0);
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

  return {
    schedule, fileName, sourceEncoding, error, acts, actsByCode, range, time, setTime, playing, setPlaying, speed, setSpeed,
    selected, selectActivity, setSelected, links, cost, boq, qty, fourD, setFourD, hideFuture, setHideFuture, openXer, downloadXer, close,
  };
}
