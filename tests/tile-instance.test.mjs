import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {tileInstance} from '../scripts/tile-instance.mjs';
import {buildMergedGlb} from '../scripts/mergeGlb.mjs';
const p = new Float32Array([0,0,0, 1,0,0, 0,.005,0]);
const n = new Float32Array([0,0,1,0,0,1,0,0,1]);
const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];

test('unsafe transforms/precision retain baked path',()=>{
 for(const m of [[-1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
  [2,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
  [1,.2,0,0,0,1,0,0,0,0,1,0,0,0,0,1]])
  assert.equal(tileInstance(p,n,m,[0,0,0]),null);
 assert.equal(tileInstance([.1,0,0], [0,0,1],identity,[0,0,0]),null);
 assert.equal(tileInstance(p,null,identity,[0,0,0]),null);
 assert.ok(tileInstance(p,n,[0,2,0,0,-2,0,0,0,0,0,2,0,250000,400000,0,1],[250000,400000,0]));
});

function readGlb(file) {
 const b=fs.readFileSync(file), size=b.readUInt32LE(12);
 const json=JSON.parse(b.subarray(20,20+size).toString());
 const bin=b.subarray(28+size);
 const accessor=i=>{
  const a=json.accessors[i],v=json.bufferViews[a.bufferView];
  const raw=Uint8Array.from(bin.subarray(v.byteOffset,v.byteOffset+v.byteLength)).buffer;
  return a.componentType===5126?new Float32Array(raw):new Uint32Array(raw);
 };
 const objects=json.nodes.map(node=>{
  const prim=json.meshes[node.mesh].primitives[0], pos=accessor(prim.attributes.POSITION);
  const norm=accessor(prim.attributes.NORMAL), idx=accessor(prim.indices),m=node.matrix??identity;
  const world=[],normal=[];
  for(const v of idx) for(let a=0;a<3;a++) {
   world.push(m[a]*pos[v*3]+m[4+a]*pos[v*3+1]+m[8+a]*pos[v*3+2]+m[12+a]);
   const nn=[0,1,2].map(k=>m[k]*norm[v*3]+m[4+k]*norm[v*3+1]+m[8+k]*norm[v*3+2]);
   normal.push(nn[a]/Math.hypot(...nn));
  }
  return {id:node.name,world,normal,material:json.materials[prim.material]};
 });
 return {objects,json,bytes:b.length,file};
}

test('real GLB conversion shares repeated geometry without losing faces, IDs, colors or placement',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'tile-reuse-'));
 const overrides={DECIMATE:'0',XKT_TILE_CAP:'100000',XKT_TILE_M:'200',XKT_INSTANCE:'0',XKT_DIAG_ONLY:'0'};
 const before=Object.fromEntries(Object.keys(overrides).map(k=>[k,process.env[k]]));
 Object.assign(process.env,overrides);
 try {
  const nodes=Array.from({length:40},(_,i)=>({kind:1,geometry:0,dbid:100+i,material:i%2,
   transform:{kind:0,elements:[0,1,0,0,-1,0,0,0,0,0,1,0,250000+i*2,400000,10,1]}}));
  const geom={kind:0,getVertices:()=>p,getNormals:()=>n,getIndices:()=>new Uint32Array([0,1,2])};
  const imf={getNodeCount:()=>nodes.length,getNode:i=>nodes[i],getGeometry:()=>geom,
   getMaterial:i=>({diffuse:{x:i?.7:.3,y:.5,z:.5}})};
  const run=async(reuse)=>{
   const dir=path.join(root,String(reuse));fs.mkdirSync(dir);
   const chunks=[];
   const result=await buildMergedGlb(imf,{tiles:true,tileReuse:reuse,xktStreamDir:dir,
    onChunk:async(file,index,tris,kind)=>{if(kind==='detail')chunks.push(readGlb(file));}});
   return {result,chunks};
  };
  const old=await run(false),next=await run(true);
  assert.equal(next.result.tileInstanceReferences,40);
  assert.deepEqual(next.result.tileAabbs,old.result.tileAabbs);
  const a=old.chunks.flatMap(c=>c.objects),b=next.chunks.flatMap(c=>c.objects);
  assert.equal(a.length,40);assert.equal(b.length,40);
  for(let i=0;i<a.length;i++) {
   assert.equal(a[i].id,b[i].id);assert.deepEqual(a[i].material,b[i].material);
   for(const key of ['world','normal']) {
    assert.equal(a[i][key].length,b[i][key].length);
    a[i][key].forEach((v,j)=>assert.ok(Math.abs(v-b[i][key][j])<1e-5));
   }
  }
  assert.ok(next.chunks.every(c=>new Set(c.json.meshes.map(m=>m.primitives[0].attributes.POSITION)).size===1));
  const bufferBytes=cs=>cs.reduce((s,c)=>s+c.json.buffers[0].byteLength,0);
  assert.ok(bufferBytes(next.chunks)<bufferBytes(old.chunks)/10);
  if (process.env.XKT_CONVERTER_MODULE) {
   const {convert2xkt}=await import(process.env.XKT_CONVERTER_MODULE);
   const summaries=[];
   for(const group of [old,next]) {
    let unique=0,meshes=0,entities=0,bytes=0;
    for(const chunk of group.chunks) {
     await convert2xkt({source:chunk.file,zip:false,outputXKT:data=>{
      const b=Buffer.from(data);assert.equal(b.readUInt32LE(0),12);
      const table=slot=>b.subarray(b.readUInt32LE(4+slot*8),b.readUInt32LE(4+slot*8)+b.readUInt32LE(8+slot*8));
      const geo=table(21);const ids=JSON.parse(table(25).toString());
      const geometryIds=Array.from({length:geo.length/4},(_,i)=>geo.readUInt32LE(i*4));
      unique+=new Set(geometryIds).size;meshes+=geometryIds.length;entities+=ids.length;bytes+=b.length;
      assert.deepEqual(ids.map(String).sort(),chunk.objects.map(o=>o.id).sort());
     }});
    }
    summaries.push({unique,meshes,entities,bytes});
   }
   assert.equal(summaries[0].meshes,summaries[1].meshes);
   assert.equal(summaries[0].entities,summaries[1].entities);
   assert.ok(summaries[1].unique<summaries[0].unique/10);
   console.log('Synthetic XKT reuse comparison:',JSON.stringify(summaries));
  }
 }finally{
  for(const [k,v]of Object.entries(before)) if(v===undefined)delete process.env[k];else process.env[k]=v;
  fs.rmSync(root,{recursive:true,force:true});
 }
});
