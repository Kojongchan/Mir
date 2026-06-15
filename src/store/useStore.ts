import { create } from 'zustand';
import type { ElementProperties } from '../viewer/IfcViewer';

interface AppState {
  isLoading: boolean;
  status: string;
  modelCount: number;
  selected: ElementProperties | null;

  setLoading: (v: boolean) => void;
  setStatus: (s: string) => void;
  setModelCount: (n: number) => void;
  setSelected: (p: ElementProperties | null) => void;
}

export const useStore = create<AppState>((set) => ({
  isLoading: false,
  status: 'IFC 파일을 불러오세요',
  modelCount: 0,
  selected: null,

  setLoading: (v) => set({ isLoading: v }),
  setStatus: (s) => set({ status: s }),
  setModelCount: (n) => set({ modelCount: n }),
  setSelected: (p) => set({ selected: p }),
}));
