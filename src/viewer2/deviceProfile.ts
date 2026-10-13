/**
 * Device tiers of the second viewer (docs/3D뷰_2차_엔진.md): every device draws within its own budget.
 *  errorTarget  screen-space error (px) before a finer level loads — larger = coarser, lighter
 *  maxBytes     loaded tile content kept in memory (LRU; unused tiles go first above minBytes)
 *  pixelRatio   cap on the device pixel ratio (fill cost grows with its square)
 *  parseJobs / downloadJobs  concurrent tile parses / downloads (parsing runs on the main thread)
 */
export type DeviceTier = 'high' | 'pc' | 'mobile';
export type DeviceProfile = { tier: DeviceTier; label: string; errorTarget: number; maxBytes: number; minBytes: number;
  pixelRatio: number; parseJobs: number; downloadJobs: number };

const MB = 1048576;
export const PROFILES: Record<DeviceTier, DeviceProfile> = {
  high: { tier: 'high', label: '고성능 PC', errorTarget: 6, maxBytes: 1024 * MB, minBytes: 768 * MB, pixelRatio: 2, parseJobs: 4, downloadJobs: 12 },
  pc: { tier: 'pc', label: '현장 PC', errorTarget: 12, maxBytes: 384 * MB, minBytes: 256 * MB, pixelRatio: 1.25, parseJobs: 2, downloadJobs: 8 },
  mobile: { tier: 'mobile', label: '모바일·태블릿', errorTarget: 20, maxBytes: 160 * MB, minBytes: 96 * MB, pixelRatio: 1.5, parseJobs: 1, downloadJobs: 6 },
};

/**
 * Picture quality over the device tier: a smaller screen error (finer levels load from farther away) with a larger
 * memory budget so they stay loaded. 「표준」 is the tier's own values.
 */
export type Quality = 'standard' | 'fine' | 'best';
export const QUALITIES: Record<Quality, { label: string; error: number; memory: number }> = {
  standard: { label: '표준', error: 1, memory: 1 },
  fine: { label: '선명', error: 0.5, memory: 1.5 },
  best: { label: '최고', error: 0.25, memory: 2 },
};
/** Cache ceiling per tier (MB) at any quality: a browser tab is stopped long before the device runs out of memory. */
const CEILING_MB: Record<DeviceTier, number> = { high: 2048, pc: 768, mobile: 240 };

/** Screen error (px) and cache budget (MB) of a tier at a quality. */
export function detailOf(profile: DeviceProfile, quality: Quality): { errorTarget: number; cacheMB: number } {
  const q = QUALITIES[quality];
  return { errorTarget: profile.errorTarget * q.error, cacheMB: Math.min(Math.round((profile.maxBytes / MB) * q.memory), CEILING_MB[profile.tier]) };
}

const rendererName =(gl: WebGLRenderingContext | WebGL2RenderingContext | null) => {
  try {
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return String(gl?.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
  } catch { return ''; }
};
const isSoftware = (name: string) => /swiftshader|llvmpipe|basic render|software/i.test(name);

/** Best guess from the browser: touch devices are mobile; a discrete GPU with ≥ 8 GB is high; the rest pc. */
export function detectTier(gl: WebGLRenderingContext | WebGL2RenderingContext | null, nav: Navigator = navigator): DeviceTier {
  const ua = nav.userAgent;
  const touchMac = /Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1; // iPadOS reports a desktop Safari
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua) || touchMac) return 'mobile';
  const renderer = rendererName(gl);
  const memory = (nav as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const discrete = /nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|apple m\d/i.test(renderer);
  return !isSoftware(renderer) && discrete && memory >= 8 ? 'high' : 'pc';
}

/**
 * Before the viewer's own context exists: the tier, and whether edge smoothing (MSAA) is worth it — on PCs with a
 * real GPU; not on phones (fill rate) or software rendering (every sample costs CPU).
 */
export function probeDevice(): { tier: DeviceTier; antialias: boolean } {
  const probe = document.createElement('canvas').getContext('webgl2');
  const tier = detectTier(probe);
  const software = isSoftware(rendererName(probe));
  probe?.getExtension('WEBGL_lose_context')?.loseContext();
  return { tier, antialias: tier !== 'mobile' && !software };
}
