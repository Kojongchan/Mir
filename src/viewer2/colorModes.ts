import type { ModelTree } from '../viewer/ModelTree';

/**
 * Colour modes of the second viewer: objects painted by the file they come from or by their classification (the
 * Revit category, or for drawings the layer without its "SOLIDS - <file> - " prefix, so a layer such as 콘크리트 or
 * 보조기층 is one class across files). The largest groups get distinct colours, the rest one grey.
 */
export type ColorMode = 'model' | 'file' | 'category';
export const COLOR_MODES: Record<ColorMode, string> = { model: '모델 색', file: '파일별', category: '분류별' };
export type LegendEntry = { name: string; count: number; rgb: [number, number, number] };

// Distinct, mid-saturated; away from the selection blue and the highlight orange.
const PALETTE: [number, number, number][] = [
  [78, 154, 143], [143, 176, 74], [201, 162, 39], [163, 93, 158], [208, 112, 127], [122, 143, 184],
  [156, 123, 85], [95, 183, 201], [181, 181, 106], [196, 107, 69], [111, 111, 168], [136, 166, 143],
];
const OTHER: [number, number, number] = [176, 176, 176];

const layerName = (name: string) => /^SOLIDS - .+? - (.+)$/.exec(name)?.[1] ?? name;

/** Group label per tree node ('' = none), each node inheriting its parent's (parents come before children). */
function groupsOf(tree: ModelTree, mode: Exclude<ColorMode, 'model'>): string[] {
  const out = new Array<string>(tree.n).fill('');
  for (let i = 1; i < tree.n; i++) {
    const parent = tree.parent[i], type = tree.type(i);
    let own = '';
    if (mode === 'file') own = type === 'File' && parent > 0 && tree.type(parent) === 'File' ? tree.name(i) : '';
    else if (type === '범주') own = tree.name(i);
    else if (type === '도면층') own = layerName(tree.name(i));
    out[i] = own || (parent >= 0 ? out[parent] : '');
  }
  return out;
}

/** Paint (rgba per dbId, a = 255 painted) and legend for a colour mode; null for the model's own colours. */
export function paintFor(tree: ModelTree, mode: ColorMode): { paint: Uint8Array; legend: LegendEntry[]; others: number } | null {
  if (mode === 'model') return null;
  const groups = groupsOf(tree, mode);
  // Objects (leaves) per group decide which groups get their own colour.
  const counts = new Map<string, number>();
  for (let i = 1; i < tree.n; i++) if (groups[i] && tree.childCount(i) === 0) counts.set(groups[i], (counts.get(groups[i]) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const colourOf = new Map<string, [number, number, number]>();
  ranked.forEach(([name], k) => colourOf.set(name, k < PALETTE.length ? PALETTE[k] : OTHER));
  const paint = new Uint8Array(tree.n * 4);
  for (let i = 1; i < tree.n; i++) {
    const rgb = groups[i] && colourOf.get(groups[i]);
    if (rgb) paint.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  }
  const legend = ranked.slice(0, PALETTE.length).map(([name, count], k) => ({ name, count, rgb: PALETTE[k] }));
  return { paint, legend, others: Math.max(0, ranked.length - PALETTE.length) };
}
