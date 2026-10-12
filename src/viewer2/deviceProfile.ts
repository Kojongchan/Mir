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

/** Best guess from the browser: touch devices are mobile; a discrete GPU with ≥ 8 GB is high; the rest pc. */
export function detectTier(gl: WebGLRenderingContext | WebGL2RenderingContext | null, nav: Navigator = navigator): DeviceTier {
  const ua = nav.userAgent;
  const touchMac = /Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1; // iPadOS reports a desktop Safari
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua) || touchMac) return 'mobile';
  const renderer = (() => {
    try {
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      return String(gl?.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
    } catch { return ''; }
  })();
  const memory = (nav as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const software = /swiftshader|llvmpipe|basic render|software/i.test(renderer);
  const discrete = /nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|apple m\d/i.test(renderer);
  return !software && discrete && memory >= 8 ? 'high' : 'pc';
}
