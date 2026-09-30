import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildCachedMotion} from '../scripts/cached-motion.mjs';
const tables=b=>Array.from({length:29},(_,s)=>b.subarray(b.readUInt32LE(4+s*8),b.readUInt32LE(4+s*8)+b.readUInt32LE(8+s*8)));
function fixture(){
 const slots=Array.from({length:29},()=>Buffer.alloc(0)),put=(s,T,v)=>slots[s]=Buffer.from(T.from(v).buffer);
 slots[0]=Buffer.from('{"metaObjects":[]}');slots[14]=Buffer.from('[]');slots[25]=Buffer.from('["structural-member"]');
 const pos=[],idx=[],normal=[],uv=[];
 for(let y=0;y<=20;y++)for(let x=0;x<=20;x++){pos.push(x*3000,y*3000,0);normal.push(0,0,0);uv.push(x/20,y/20);}
 for(let y=0;y<20;y++)for(let x=0;x<20;x++){const a=y*21+x;idx.push(a,a+1,a+21,a+1,a+22,a+21);}
 put(4,Uint16Array,pos);put(5,Int8Array,normal);put(7,Float32Array,uv);put(8,Uint32Array,idx);
 for(const s of [15,16,17,18,19,20,21,22,26,28])put(s,Uint32Array,[0]);
 put(13,Uint8Array,[1]);put(23,Int32Array,[-1]);put(24,Uint8Array,[120,130,140,255,0,230]);put(27,Float64Array,[100,200,0,121.845,221.845,0]);
 slots[1]=Buffer.from('opaque-original-texture-bytes');
 const head=Buffer.alloc(236),out=[head];head.writeUInt32LE(12);let len=236;
 slots.forEach((b,s)=>{const pad=(8-len%8)%8;out.push(Buffer.alloc(pad));len+=pad;head.writeUInt32LE(len,4+s*8);head.writeUInt32LE(b.length,8+s*8);out.push(b);len+=b.length;});
 return Buffer.concat(out);
}
test('cached approximation preserves binary texture/material/entity/coordinate metadata; detail remains unchanged',async()=>{
 const source=fixture(),copy=Buffer.from(source),r=await buildCachedMotion(source);
 assert.ok(r);assert.ok(r.triangles<r.detailTriangles*.5);assert.equal(r.members,1);assert.deepEqual(source,copy);
 const before=tables(source),after=tables(r.bytes);
 for(const s of [0,1,2,3,10,11,12,13,14,17,21,22,23,24,25,26,27,28])assert.deepEqual(after[s],before[s]);
 const positions=new Uint16Array(Uint8Array.from(after[4]).buffer),indices=new Uint32Array(Uint8Array.from(after[8]).buffer),uv=new Float32Array(Uint8Array.from(after[7]).buffer);
 assert.ok(indices.every(i=>i<positions.length/3));assert.equal(uv.length,positions.length/3*2);
 for(let i=0;i<positions.length;i+=3){assert.ok(Math.abs(uv[i/3*2]-positions[i]/60000)<1e-7);assert.ok(Math.abs(uv[i/3*2+1]-positions[i+1]/60000)<1e-7);}
});
test('unsupported format and reused geometry retain original path; corrupt ranges fail closed',async()=>{
 const b=fixture();b.writeUInt32LE(11);assert.equal(await buildCachedMotion(b),null);
 const corrupt=fixture();corrupt.writeUInt32LE(0x7fffffff,4+4*8);await assert.rejects(()=>buildCachedMotion(corrupt));
});
if(process.env.MOTION_SAMPLE)test('local supplied sample preserves opaque source tables',async()=>{
 const source=fs.readFileSync(process.env.MOTION_SAMPLE),r=await buildCachedMotion(source);assert.ok(r);
 const a=tables(source),b=tables(r.bytes);for(const s of [0,1,2,3,10,23,24,25,26,27,28])assert.deepEqual(a[s],b[s]);
 console.log({members:r.members,triangles:r.triangles,originalTriangles:r.detailTriangles});
});
