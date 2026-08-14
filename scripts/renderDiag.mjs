// 진단: 러너 안에서 out/model.glb 를 앱과 동일한 xeokit 설정으로 헤드리스 렌더 →
// 캔버스를 ASCII 로 로그(다운로드 불가 환경에서 '무엇이 실제로 그려지는지' 눈으로 확인).
import http from 'node:http';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';

const glbPath = process.argv[2] || 'out/model.glb';
const xeokitDist = 'node_modules/@xeokit/xeokit-sdk/dist/xeokit-sdk.es.js';
const W = 1000, H = 700;

// focus(회전 전 실좌표)를 로드 회전 [-90,0,0] 축변환((x,y,z)→(x,z,-y))으로 world AABB 로.
let focusAabb = null;
if (process.env.PW_NO_FOCUS === '1') { console.log('[diag-render] PW_NO_FOCUS — 청크 자체 AABB 로 fit(전체 focus 무시)'); }
else try {
  const f = JSON.parse(fs.readFileSync('out/focus.json', 'utf8'));
  const [cx, cy, cz] = f.center, [hx, hy, hz] = f.half;
  const wc = [cx, cz, -cy], wh = [hx, hz, hy];
  focusAabb = [wc[0] - wh[0], wc[1] - wh[1], wc[2] - wh[2], wc[0] + wh[0], wc[1] + wh[1], wc[2] + wh[2]];
  console.log('[diag-render] focus aabb', JSON.stringify(focusAabb));
} catch { console.log('[diag-render] focus.json 없음 — 전체 fit'); }

const html = `<!doctype html><html><head><meta charset=utf-8><style>html,body{margin:0}#c{width:${W}px;height:${H}px}</style></head><body>
<canvas id=c width=${W} height=${H}></canvas>
<script type=module>
import {Viewer,GLTFLoaderPlugin,XKTLoaderPlugin,KTX2TextureTranscoder} from '/xeokit.js';
const IS_XKT=${glbPath.endsWith('.xkt') ? 'true' : 'false'};
const v=new Viewer({canvasId:'c',transparent:false,backgroundColor:[0.13,0.14,0.16],dtxEnabled:false,saoEnabled:false,logarithmicDepthBufferEnabled:true});
v.camera.perspective.near=0.5;v.camera.perspective.far=1e7;v.camera.ortho.near=0.5;v.camera.ortho.far=1e7;
const fetchBuf=(url,ok,err)=>fetch(url).then(r=>r.arrayBuffer()).then(ok).catch(e=>err(String(e)));
// XKT 의 Basis 텍스처 디코드 — 앱과 동일하게 self-host 한 /basis/ 트랜스코더 사용.
const l=IS_XKT ? new XKTLoaderPlugin(v,{dataSource:{getXKT:fetchBuf},textureTranscoder:new KTX2TextureTranscoder(v,{transcoderPath:'/basis/'})}) : new GLTFLoaderPlugin(v);
const m=l.load({id:'t',src:IS_XKT?'/model.xkt':'/model.glb',edges:false,rotation:[-90,0,0],dtxEnabled:false});
const FOCUS=${focusAabb ? JSON.stringify(focusAabb) : 'null'};
const OBLIQUE=${process.env.PW_OBLIQUE === '1' ? 'true' : 'false'};
m.on('loaded',()=>{const a=m.aabb;console.log('AABB',JSON.stringify(a));
  const box=FOCUS||a;
  const cx=(box[0]+box[3])/2, cy=(box[1]+box[4])/2, cz=(box[2]+box[5])/2;
  const horiz=Math.max(box[3]-box[0], box[5]-box[2], 100);
  if(OBLIQUE){ // 비스듬 시점(계단/기복 프로파일 확인용)
    const d=horiz*0.9; v.camera.eye=[cx+d*0.7, cy+d*0.6, cz+d*0.7]; v.camera.look=[cx,cy,cz]; v.camera.up=[0,1,0];
  } else { // 평면 → top-down
    v.camera.eye=[cx, cy+horiz*0.7, cz]; v.camera.look=[cx,cy,cz]; v.camera.up=[0,0,-1];
  }
  setTimeout(()=>{window.__done=1;document.title='DONE';},1500);});
m.on('error',e=>{document.title='ERR:'+e;window.__done=1;});
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/index')) { res.setHeader('content-type', 'text/html'); res.end(html); }
  else if (req.url === '/xeokit.js') { res.setHeader('content-type', 'text/javascript'); res.end(fs.readFileSync(xeokitDist)); }
  else if (req.url.startsWith('/model.glb') || req.url.startsWith('/model.xkt')) { res.setHeader('content-type', 'application/octet-stream'); res.end(fs.readFileSync(glbPath)); }
  else if (req.url.startsWith('/basis/')) {
    // self-host 한 Basis 트랜스코더(public/basis/basis_transcoder.{js,wasm}) 서빙.
    const name = req.url.slice('/basis/'.length).split('?')[0];
    const fp = `public/basis/${name}`;
    if (/^basis_transcoder\.(js|wasm)$/.test(name) && fs.existsSync(fp)) {
      res.setHeader('content-type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
      res.end(fs.readFileSync(fp));
    } else { res.statusCode = 404; res.end('x'); }
  }
  else { res.statusCode = 404; res.end('x'); }
});
await new Promise((r) => server.listen(8123, r));

const b = await chromium.launch({
  ...(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {}),
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const p = await b.newPage({ viewport: { width: W, height: H } });
p.on('console', (m) => console.log('[browser]', m.text()));
p.on('pageerror', (e) => console.log('[pageerr]', e.message));
await p.goto('http://localhost:8123/', { waitUntil: 'load' });
try { await p.waitForFunction('window.__done===1', { timeout: 60000 }); } catch { console.log('[diag-render] timeout title=', await p.title()); }
const buf = await p.screenshot();
if (process.env.PW_SAVE) { fs.writeFileSync(process.env.PW_SAVE, buf); console.log('[diag-render] 스샷 저장', process.env.PW_SAVE); }
const png = PNG.sync.read(buf);

// 배경(어두운 회색 ~33,36,41)과 다른 픽셀 = 그려진 지오메트리. 밝기 대신 '배경과의 거리'로
// 판정해 밝은 색(노랑·시안)도 잡는다. ASCII 는 배경차이 강도.
const BG = [33, 36, 41];
const cols = 120, rows = 48, chars = ' .:-=+*#%@';
let ascii = '';
for (let ry = 0; ry < rows; ry++) {
  let line = '';
  for (let cx = 0; cx < cols; cx++) {
    const px = Math.floor((cx / cols) * png.width), py = Math.floor((ry / rows) * png.height);
    const i = (py * png.width + px) * 4;
    const d = Math.abs(png.data[i] - BG[0]) + Math.abs(png.data[i + 1] - BG[1]) + Math.abs(png.data[i + 2] - BG[2]);
    const ci = Math.min(chars.length - 1, Math.floor((d / 300) * chars.length));
    line += chars[ci];
  }
  ascii += line + '\n';
}
// 렌더된(배경과 다른) 픽셀 수 + 색 히스토그램(3단계 양자화).
let drawn = 0;
const hist = new Map();
for (let i = 0; i < png.data.length; i += 4) {
  const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
  const d = Math.abs(r - BG[0]) + Math.abs(g - BG[1]) + Math.abs(b - BG[2]);
  if (d > 40) {
    drawn++;
    const q = `${Math.round(r / 85)}_${Math.round(g / 85)}_${Math.round(b / 85)}`; // 0..3 각채널
    hist.set(q, (hist.get(q) || 0) + 1);
  }
}
console.log(`[diag-render] 렌더된(배경≠) 픽셀 ${drawn} / ${png.width * png.height} (${(drawn / (png.width * png.height) * 100).toFixed(1)}%)`);
const topH = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
console.log('[diag-render] 렌더된 색 히스토그램 r_g_b(0~3) → 픽셀수:');
for (const [k, c] of topH) console.log(`[diag-render]   ${k} → ${c.toLocaleString()}`);
console.log('[diag-render] ASCII(120x48):\n' + ascii);

// 실제 렌더 이미지를 축소해 base64 PNG 로 로그에 남긴다(아티팩트 다운로드가 막혀 있어
// 러너 밖에서 '눈으로' 확인할 유일한 방법). 로컬에서 base64 를 디코드해 PNG 로 본다.
const OW = 360, OH = Math.round(OW * png.height / png.width);
const small = new PNG({ width: OW, height: OH });
for (let y = 0; y < OH; y++) {
  for (let x = 0; x < OW; x++) {
    const sx = Math.floor(x / OW * png.width), sy = Math.floor(y / OH * png.height);
    const si = (sy * png.width + sx) * 4, di = (y * OW + x) * 4;
    small.data[di] = png.data[si]; small.data[di + 1] = png.data[si + 1];
    small.data[di + 2] = png.data[si + 2]; small.data[di + 3] = 255;
  }
}
const b64 = PNG.sync.write(small).toString('base64');
console.log(`[diag-png] BEGIN ${OW}x${OH} len=${b64.length}`);
for (let i = 0; i < b64.length; i += 180) console.log('[diag-png] ' + b64.slice(i, i + 180));
console.log('[diag-png] END');
await b.close(); server.close(); process.exit(0);
