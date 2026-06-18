import { create } from 'zustand';
import type { ElementProperties } from '../viewer/IfcViewer';
import { type AppearanceSettings, DEFAULT_APPEARANCE } from '../viewer/IfcViewer';
import type { ScheduleTask, ScheduleSource } from '../lib/schedule';
import type { TaskMapping } from '../lib/fourd';

interface AppState {
  isLoading: boolean;
  status: string;
  modelCount: number;
  selected: ElementProperties | null;

  setLoading: (v: boolean) => void;
  setStatus: (s: string) => void;
  setModelCount: (n: number) => void;
  setSelected: (p: ElementProperties | null) => void;

  // --- 4D 시공 시뮬레이션 ---
  fourd: FourDState;
}

export interface FourDState {
  enabled: boolean;
  tasks: ScheduleTask[];
  source: ScheduleSource | null;
  /** 일정 전체 범위(epoch ms) */
  rangeStart: number;
  rangeEnd: number;
  /** 현재 시점(타임슬라이더, epoch ms) */
  currentTime: number;
  /** 표시 설정(유형별 색상·반투명·미시공 ghost) */
  appearance: AppearanceSettings;
  /** 작업 id → 요소 참조 */
  mapping: TaskMapping;
  /** 매핑 통계(표시용) */
  mappedTasks: number;
  mappedElements: number;

  loadSchedule: (p: {
    tasks: ScheduleTask[];
    source: ScheduleSource;
    start: number;
    end: number;
  }) => void;
  clearSchedule: () => void;
  setEnabled: (v: boolean) => void;
  setCurrentTime: (t: number) => void;
  setAppearance: (patch: Partial<AppearanceSettings>) => void;
  setMapping: (m: TaskMapping, tasks: number, elements: number) => void;
}

const emptyFourD = {
  enabled: false,
  tasks: [] as ScheduleTask[],
  source: null as ScheduleSource | null,
  rangeStart: NaN,
  rangeEnd: NaN,
  currentTime: NaN,
  appearance: { ...DEFAULT_APPEARANCE },
  mapping: {} as TaskMapping,
  mappedTasks: 0,
  mappedElements: 0,
};

export const useStore = create<AppState>((set) => ({
  isLoading: false,
  status: 'IFC 파일을 불러오세요',
  modelCount: 0,
  selected: null,

  setLoading: (v) => set({ isLoading: v }),
  setStatus: (s) => set({ status: s }),
  setModelCount: (n) => set({ modelCount: n }),
  setSelected: (p) => set({ selected: p }),

  fourd: {
    ...emptyFourD,
    loadSchedule: ({ tasks, source, start, end }) =>
      set((s) => ({
        fourd: {
          ...s.fourd,
          tasks,
          source,
          rangeStart: start,
          rangeEnd: end,
          currentTime: start,
          enabled: true,
          mapping: {},
          mappedTasks: 0,
          mappedElements: 0,
        },
      })),
    clearSchedule: () => set((s) => ({ fourd: { ...s.fourd, ...emptyFourD } })),
    setEnabled: (v) => set((s) => ({ fourd: { ...s.fourd, enabled: v } })),
    setCurrentTime: (t) => set((s) => ({ fourd: { ...s.fourd, currentTime: t } })),
    setAppearance: (patch) =>
      set((s) => ({ fourd: { ...s.fourd, appearance: { ...s.fourd.appearance, ...patch } } })),
    setMapping: (mapping, mappedTasks, mappedElements) =>
      set((s) => ({ fourd: { ...s.fourd, mapping, mappedTasks, mappedElements } })),
  },
}));
