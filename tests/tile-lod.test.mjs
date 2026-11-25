import test from 'node:test';
import assert from 'node:assert/strict';
import { simplifyTileMesh } from '../scripts/tile-lod.mjs';
import { buildMergedGlb } from '../scripts/mergeGlb.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
function grid(n=20) {
 const p=[],norm=[],idx=[];
 for(let y=0;y<=n;y++)for(let x=0;x<=n;x++){p.push(x,y,0);norm.push(0,0,1);}
 for(let y=0;y<n;y++)for(let x=0;x<n;x++){const a=y*(n+1)+x;idx.push(a,a+1,a+n+1,a+1,a+n+2,a+n+1);}
 return {pos:Float32Array.from(p),nrm:Float32Array.from(norm),idx:Uint32Array.from(idx)};
}
test('reduces interior tessellation, locks border, retains tiny disconnected component',async()=>{
 const g=grid(),v=g.pos.length/3;
 const pos=Float32Array.from([...g.pos,30,0,0,30.00001,0,0,30,0.00001,0]);
 const nrm=Float32Array.from([...g.nrm,0,0,1,0,0,1,0,0,1]);
 const result=await simplifyTileMesh(pos,nrm,Uint32Array.from([...g.idx,v,v+1,v+2]));
 assert.ok(result.reduced);assert.ok(result.idx.length<g.idx.length*.4);
 const originalBorder=new Set();
 for(let i=0;i<g.pos.length;i+=3)if(g.pos[i]===0||g.pos[i]===20||g.pos[i+1]===0||g.pos[i+1]===20)originalBorder.add(`${g.pos[i]},${g.pos[i+1]},${g.pos[i+2]}`);
 const output=new Set();for(let i=0;i<result.pos.length;i+=3)output.add(`${result.pos[i]},${result.pos[i+1]},${result.pos[i+2]}`);
 for(const p of originalBorder)assert.ok(output.has(p));
 assert.ok(output.has('30,0,0'));assert.ok(output.has(`${pos[pos.length-6]},0,0`));
 assert.ok(result.idx.every(i=>i<result.pos.length/3));
 console.log(`grid: ${g.idx.length/3+1} → ${result.idx.length/3} triangles`);
});
test('small thin meshes unchanged; malformed data refused',async()=>{
 const pos=Float32Array.from([0,0,0,1,0,0,0,.00001,0]),nrm=Float32Array.from([0,0,1,0,0,1,0,0,1]),idx=Uint32Array.from([0,1,2]);
 assert.equal((await simplifyTileMesh(pos,nrm,idx)).idx,idx);
 await assert.rejects(()=>simplifyTileMesh(pos,nrm,Uint32Array.from([0,1,99])));
});
test('paired GLB keeps every node and material with detail unchanged',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'motion-lod-')); const g=grid();
 const nodes=[0,1,2].map(i=>({kind:1,geometry:0,dbid:100+i,material:i,transform:{kind:0,elements:[1,0,0,0,0,1,0,0,0,0,1,0,i*30,0,0,1]}}));
 const imf={getNodeCount:()=>nodes.length,getNode:i=>nodes[i],getGeometry:()=>({kind:0,getVertices:()=>g.pos,getNormals:()=>g.nrm,getIndices:()=>g.idx}),getMaterial:i=>({diffuse:{x:i/3,y:.5,z:.5}})};
 const read=p=>{const b=fs.readFileSync(p);return JSON.parse(b.subarray(20,20+b.readUInt32LE(12)));};
 try {
 const chunks={};
 const res=await buildMergedGlb(imf,{tiles:true,motionLod:true,xktStreamDir:root,onChunk:async(p,i,t,kind)=>{
   chunks[kind]={json:read(p),tris:t};
   if(process.env.XKT_CONVERTER_MODULE && ['detail','motion'].includes(kind)) {
    const {convert2xkt}=await import(process.env.XKT_CONVERTER_MODULE);
    await convert2xkt({source:p,zip:false,outputXKT:data=>{
     const b=Buffer.from(data),slot=25;
     const ids=JSON.parse(b.subarray(b.readUInt32LE(4+slot*8),b.readUInt32LE(4+slot*8)+b.readUInt32LE(8+slot*8)).toString());
     assert.deepEqual(ids.map(String).sort(),['100','101','102']);
    }});
   }
  }});
 assert.ok(chunks.motion);assert.equal(chunks.detail.tris,2400);
 assert.deepEqual(chunks.motion.json.nodes.map(n=>n.name),chunks.detail.json.nodes.map(n=>n.name));
 assert.deepEqual(chunks.motion.json.materials,chunks.detail.json.materials);
 assert.equal(res.tileLods.c0.members,3);assert.ok(chunks.motion.tris<chunks.detail.tris*.4);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
