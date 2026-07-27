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
try {
  const f = JSON.parse(fs.readFileSync('out/focus.json', 'utf8'));
  const [cx, cy, cz] = f.center, [hx, hy, hz] = f.half;
  const wc = [cx, cz, -cy], wh = [hx, hz, hy];
  focusAabb = [wc[0] - wh[0], wc[1] - wh[1], wc[2] - wh[2], wc[0] + wh[0], wc[1] + wh[1], wc[2] + wh[2]];
  console.log('[diag-render] focus aabb', JSON.stringify(focusAabb));
} catch { console.log('[diag-render] focus.json 없음 — 전체 fit'); }

const html = `<!doctype html><html><head><meta charset=utf-8><style>html,body{margin:0}#c{width:${W}px;height:${H}px}</style></head><body>
<canvas id=c width=${W} height=${H}></canvas>
<script type=module>
import {Viewer,GLTFLoaderPlugin} from '/xeokit.js';
const v=new Viewer({canvasId:'c',transparent:false,backgroundColor:[1,1,1],dtxEnabled:false,saoEnabled:true,logarithmicDepthBufferEnabled:true});
v.camera.perspective.near=0.5;v.camera.perspective.far=1e7;v.camera.ortho.near=0.5;v.camera.ortho.far=1e7;
const l=new GLTFLoaderPlugin(v);
const m=l.load({id:'t',src:'/model.glb',edges:false,rotation:[-90,0,0],dtxEnabled:false});
const FOCUS=${focusAabb ? JSON.stringify(focusAabb) : 'null'};
m.on('loaded',()=>{const a=m.aabb;console.log('AABB',JSON.stringify(a));
  const box=FOCUS||a;
  const cx=(box[0]+box[3])/2, cy=(box[1]+box[4])/2, cz=(box[2]+box[5])/2;
  const horiz=Math.max(box[3]-box[0], box[5]-box[2], 100);
  // 평면 도면은 XZ 평면(Y=고도)에 눕는다 → Y 위에서 수직 하방(top-down)으로 봐야 면이 보인다.
  v.camera.eye=[cx, cy+horiz*0.75, cz]; v.camera.look=[cx,cy,cz]; v.camera.up=[0,0,-1];
  setTimeout(()=>{window.__done=1;document.title='DONE';},1500);});
m.on('error',e=>{document.title='ERR:'+e;window.__done=1;});
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/index')) { res.setHeader('content-type', 'text/html'); res.end(html); }
  else if (req.url === '/xeokit.js') { res.setHeader('content-type', 'text/javascript'); res.end(fs.readFileSync(xeokitDist)); }
  else if (req.url.startsWith('/model.glb')) { res.setHeader('content-type', 'model/gltf-binary'); res.end(fs.readFileSync(glbPath)); }
  else { res.statusCode = 404; res.end('x'); }
});
await new Promise((r) => server.listen(8123, r));

const b = await chromium.launch({ args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] });
const p = await b.newPage({ viewport: { width: W, height: H } });
p.on('console', (m) => console.log('[browser]', m.text()));
p.on('pageerror', (e) => console.log('[pageerr]', e.message));
await p.goto('http://localhost:8123/', { waitUntil: 'load' });
try { await p.waitForFunction('window.__done===1', { timeout: 60000 }); } catch { console.log('[diag-render] timeout title=', await p.title()); }
const buf = await p.screenshot();
const png = PNG.sync.read(buf);

const cols = 120, rows = 48, chars = ' .:-=+*#%@';
let ascii = '';
for (let ry = 0; ry < rows; ry++) {
  let line = '';
  for (let cx = 0; cx < cols; cx++) {
    const px = Math.floor((cx / cols) * png.width), py = Math.floor((ry / rows) * png.height);
    const i = (py * png.width + px) * 4;
    const lum = (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
    const ci = Math.min(chars.length - 1, Math.floor(((255 - lum) / 255) * chars.length));
    line += chars[ci];
  }
  ascii += line + '\n';
}
let nonwhite = 0;
for (let i = 0; i < png.data.length; i += 4) if (png.data[i] < 245 || png.data[i + 1] < 245 || png.data[i + 2] < 245) nonwhite++;
console.log(`[diag-render] 비흰색 픽셀 ${nonwhite} / ${png.width * png.height} (${(nonwhite / (png.width * png.height) * 100).toFixed(1)}%)`);
console.log('[diag-render] ASCII(120x48):\n' + ascii);
await b.close(); server.close(); process.exit(0);
