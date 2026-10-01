import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';
import { gunzipSync } from 'node:zlib';
import { randomUUID, createHash } from 'node:crypto';
import { buildCachedMotion } from './cached-motion.mjs';
import { encodeXktTransfer } from './xkt-transfer.mjs';
import { checkStorageBudget } from './storage-budget.mjs';
const env=process.env;let prefix=env.MODEL_CACHE_PREFIX;
if(!/^[A-Za-z0-9]{1,40}$/.test(prefix??''))throw Error('Invalid cache identifier');
const client=new S3Client({region:'auto',endpoint:`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,credentials:{accessKeyId:env.R2_ACCESS_KEY_ID,secretAccessKey:env.R2_SECRET_ACCESS_KEY}}),Bucket=env.R2_BUCKET;
// A per-URN key without its own manifest may alias a claimed legacy directory (api/aps-convert.ts resolveCacheDir).
const missing=e=>e?.name==='NoSuchKey'||e?.name==='NotFound'||e?.$metadata?.httpStatusCode===404;
let own=true;try{await client.send(new HeadObjectCommand({Bucket,Key:`${prefix}/xkt/manifest.json`}));}catch(e){if(!missing(e))throw e;own=false;}
if(!own)try{const r=await client.send(new GetObjectCommand({Bucket,Key:`${prefix}/alias.json`}));const alias=JSON.parse(Buffer.from(await r.Body.transformToByteArray()).toString());
 if(/^[A-Za-z0-9]{1,40}$/.test(alias?.prefix??'')){console.log(`Alias ${prefix} -> ${alias.prefix}`);prefix=alias.prefix;}}catch(e){if(!missing(e))throw e;}
const key=`${prefix}/xkt/manifest.json`;
const get=async Key=>{const r=await client.send(new GetObjectCommand({Bucket,Key}));if(r.ContentLength>128*1048576)throw Error('Oversized source');const bytes=Buffer.from(await r.Body.transformToByteArray());return {bytes:bytes[0]===31&&bytes[1]===139?gunzipSync(bytes,{maxOutputLength:128*1048576}):bytes,etag:r.ETag};};
const source=await get(key),manifest=JSON.parse(source.bytes),generation=`runs/${randomUUID()}`;
if(!Array.isArray(manifest.tiles)||!manifest.tiles.length||manifest.inst?.length)throw Error('Unsupported manifest');
let generated=0,skipped=0,added=0;
manifest.chunkInfo??={};
for(let i=0;i<manifest.tiles.length;i++){
 const tile=manifest.tiles[i];if(tile.motion){skipped++;continue;}
 if(typeof tile.n!=='string'||!/^([A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.xkt$/.test(tile.n))throw Error('Unsafe cache path');
 const original=await get(`${prefix}/xkt/${tile.n}`);
 const result=await buildCachedMotion(original.bytes);
 if(!result){skipped++;continue;}
 const packed=encodeXktTransfer(result.bytes);
 // This validation job adds at most 256MB; further runs reuse published pairs.
 if(added+packed.body.length>256*1048576)break;
 await checkStorageBudget(token=>client.send(new ListObjectsV2Command({Bucket,MaxKeys:1000,...(token?{ContinuationToken:token}:{})})),packed.body.length);
 const n=`${generation}/motion${i}.xkt`;
 await client.send(new PutObjectCommand({Bucket,Key:`${prefix}/xkt/${n}`,Body:packed.body,ContentType:'application/octet-stream',...(packed.contentEncoding?{ContentEncoding:packed.contentEncoding}:{})}));
 const verify=await get(`${prefix}/xkt/${n}`);
 if(!verify.bytes.equals(result.bytes))throw Error('Stored motion bytes differ');
 tile.motion={n,byteLength:result.bytes.length,policy:result.policy,members:result.members,detailTriangles:result.detailTriangles,triangles:result.triangles,
   sourceSha256:createHash('sha256').update(original.bytes).digest('hex'),shading:'flat-during-motion'};
 manifest.chunkInfo[n]={byteLength:result.bytes.length,transferByteLength:packed.body.length,kind:'motion'};
 generated++;added+=packed.body.length;
 console.log(`Validated pairs ${generated}; scanned ${i+1}/${manifest.tiles.length}; added ${Math.round(added/1048576)}MiB`);
}
if(!generated)throw Error(`No useful safe pairs generated (${skipped} skipped); detail unchanged`);
const body=Buffer.from(JSON.stringify(manifest));
await checkStorageBudget(token=>client.send(new ListObjectsV2Command({Bucket,MaxKeys:1000,...(token?{ContinuationToken:token}:{})})),body.length);
// Refuse to overwrite a concurrently replaced manifest. Never delete original files.
await client.send(new PutObjectCommand({Bucket,Key:key,Body:body,ContentType:'application/json',IfMatch:source.etag}));
console.log(`Published ${generated} optional pairs; ${skipped} unchanged detail tiles. Performance needs client validation.`);
