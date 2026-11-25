import { createClient } from '@supabase/supabase-js';
import { AwsClient } from 'aws4fetch';

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ACCOUNT = process.env.R2_ACCOUNT_ID;
const KEY = process.env.R2_ACCESS_KEY_ID;
const SECRET = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET = process.env.R2_BUCKET;
const endpoint = `https://${ACCOUNT}.r2.cloudflarestorage.com/${BUCKET}`;
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

// S3 ListObjectsV2 emits escaped XML. Only parse fields inside <Contents>.
const decodeXml = (value: string) => value.replace(/&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos);/gi,
  (match, code: string | undefined, named: string | undefined) => {
    if (code) {
      const number = Number.parseInt(code.slice(0, 1).toLowerCase() === 'x' ? code.slice(1) : code, code[0].toLowerCase() === 'x' ? 16 : 10);
      return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : match;
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[named!.toLowerCase()] ?? match;
  });
const tag = (xml: string, name: string) => {
  const match = new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`).exec(xml);
  return match ? decodeXml(match[1]) : undefined;
};

export function parseR2List(xml: string): { objects: { key: string; bytes: number }[]; next?: string } {
  if (!/<ListBucketResult(?:\s[^>]*)?>/.test(xml)) throw new Error('Invalid R2 inventory response');
  const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((match) => {
    const key = tag(match[1], 'Key'), size = Number(tag(match[1], 'Size'));
    if (!key || !Number.isSafeInteger(size) || size < 0) throw new Error('Invalid R2 inventory entry');
    return { key, bytes: size };
  });
  const truncated = tag(xml, 'IsTruncated') === 'true';
  const next = tag(xml, 'NextContinuationToken');
  if (truncated && !next) throw new Error('Incomplete R2 inventory page');
  return { objects, next: truncated ? next : undefined };
}

export function inventorySummary(objects: { key: string; bytes: number }[], manifests: Map<string, unknown>) {
  const groups = new Map<string, { bytes: number; objects: number; files: { key: string; bytes: number }[] }>();
  let totalBytes = 0;
  for (const object of objects) {
    totalBytes += object.bytes;
    const prefix = object.key.split('/')[0] || '(root)';
    const group = groups.get(prefix) ?? { bytes: 0, objects: 0, files: [] };
    group.bytes += object.bytes; group.objects++; group.files.push(object);
    groups.set(prefix, group);
  }
  return {
    totalBytes, targetReductionBytes: Math.max(0, totalBytes - 9_800_000_000),
    groups: [...groups].map(([prefix, group]) => {
      const candidate = manifests.get(prefix);
      const m = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : null;
      const xktFiles = m?.xktFiles;
      const valid = Array.isArray(xktFiles) && xktFiles.length > 0 && xktFiles.every(x => typeof x === 'string' && x.endsWith('.xkt'));
      const referenced = new Set<string>();
      if (valid) {
        for (const field of ['xktFiles', 'navFiles', 'base', 'inst']) {
          const names = m?.[field];
          if (!Array.isArray(names) || !names.every(n => typeof n === 'string')) { if (names !== undefined) return { prefix, ...groupInfo(group), state: 'invalid-manifest', staleXktBytes: null }; continue; }
          for (const name of names) referenced.add(`${prefix}/xkt/${name}`);
        }
        if (typeof m?.lod1 === 'string') referenced.add(`${prefix}/xkt/${m.lod1}`);
        const tiles = m?.tiles;
        if (Array.isArray(tiles)) for (const tile of tiles) {
          if (!tile || typeof tile.n !== 'string') return { prefix, ...groupInfo(group), state: 'invalid-manifest', staleXktBytes: null };
          referenced.add(`${prefix}/xkt/${tile.n}`);
          if (tile.motion != null) {
            if (typeof tile.motion.n !== 'string') return { prefix, ...groupInfo(group), state: 'invalid-manifest', staleXktBytes: null };
            referenced.add(`${prefix}/xkt/${tile.motion.n}`);
          }
        }
      }
      if (valid && m?.tiles != null && !Array.isArray(m.tiles)) return { prefix, ...groupInfo(group), state: 'invalid-manifest', staleXktBytes: null };
      const existing = new Set(group.files.map(file => file.key));
      const missing = valid ? [...referenced].filter(key => !existing.has(key)).length : 0;
      return {
        prefix, ...groupInfo(group), state: !valid ? 'no-valid-manifest' : missing ? 'missing-live-objects' : 'manifest-valid',
        referencedXktBytes: valid && !missing ? group.files.filter(file => referenced.has(file.key)).reduce((a, file) => a + file.bytes, 0) : null,
        staleXktBytes: valid && !missing ? group.files.filter(file => file.key.startsWith(`${prefix}/xkt/`) &&
          file.key.endsWith('.xkt') && !referenced.has(file.key)).reduce((a, file) => a + file.bytes, 0) : null,
      };
    }).sort((a, b) => b.bytes - a.bytes),
  };
}
function groupInfo(group: { bytes: number; objects: number }) { return { bytes: group.bytes, objects: group.objects }; }

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') return reply({ error: 'method not allowed' }, 405);
  if (!SUPABASE_URL || !SERVICE_ROLE || !ACCOUNT || !KEY || !SECRET || !BUCKET) return reply({ error: 'storage settings missing' }, 503);
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!bearer) return reply({ error: 'authentication required' }, 401);
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
  const { data: userData, error } = await admin.auth.getUser(bearer);
  if (error || !userData.user) return reply({ error: 'invalid session' }, 401);
  const { data: profile } = await admin.from('profiles').select('is_admin').eq('id', userData.user.id).maybeSingle();
  if (!profile?.is_admin) {
    const projectId = new URL(req.url).searchParams.get('projectId');
    if (!projectId || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(projectId)) return reply({ error: '프로젝트 관리자 권한이 필요합니다.' }, 403);
    const { data: membership, error: memberError } = await admin.from('project_members').select('role')
      .eq('project_id', projectId).eq('user_id', userData.user.id).maybeSingle();
    if (memberError || membership?.role !== 'admin') return reply({ error: '프로젝트 관리자 권한이 필요합니다.' }, 403);
  }
  const client = new AwsClient({ accessKeyId: KEY, secretAccessKey: SECRET, service: 's3', region: 'auto' });
  try {
    const objects: { key: string; bytes: number }[] = [];
    let token: string | undefined;
    for (let page = 0; page < 50; page++) {
      const url = new URL(endpoint);
      url.searchParams.set('list-type', '2'); url.searchParams.set('max-keys', '1000');
      if (token) url.searchParams.set('continuation-token', token);
      const response = await client.fetch(url.href);
      if (!response.ok) throw new Error('R2 inventory unavailable');
      const batch = parseR2List(await response.text());
      objects.push(...batch.objects); token = batch.next;
      if (!token) break;
      if (page === 49) throw new Error('R2 inventory exceeds 50 pages');
    }
    const manifestKeys = objects.filter(object => object.key.endsWith('/xkt/manifest.json'));
    if (manifestKeys.length > 100) throw new Error('Too many manifests for a bounded audit');
    const manifests = new Map<string, unknown>();
    for (const item of manifestKeys) {
      const prefix = item.key.split('/')[0];
      // Multiple manifest generations under one prefix make any single one unsafe
      // as the sole source of live references.
      if (manifestKeys.filter(entry => entry.key.split('/')[0] === prefix).length !== 1) {
        manifests.set(prefix, null);
        continue;
      }
      const response = await client.fetch(`${endpoint}/${item.key.split('/').map(encodeURIComponent).join('/')}`);
      if (!response.ok) throw new Error('Cannot inspect cached manifest');
      try { manifests.set(prefix, await response.json()); }
      catch { manifests.set(prefix, null); }
    }
    return reply({ ...inventorySummary(objects, manifests), inspectedAt: new Date().toISOString(),
      note: 'Read-only snapshot. Stale XKT estimate requires manifest validation; no object was modified or marked for automatic deletion.' });
  } catch { return reply({ error: '저장소 목록을 끝까지 확인하지 못했습니다. 파일을 변경하지 않았습니다.' }, 503); }
}
