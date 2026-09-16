import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectXkt } from '../scripts/inspect-xkt.mjs';
function fixture(badIndex=false) {
  const blocks=Array.from({length:29},()=>Buffer.alloc(0));
  const put=(i,Type,v)=>{blocks[i]=Buffer.from(new Type(v).buffer);};
  put(4,Uint16Array,[0,0,0,65535,0,0,0,65535,0]);put(8,Uint32Array,[0,1,badIndex?3:2]);
  put(13,Uint8Array,[1]);put(15,Uint32Array,[0]);put(19,Uint32Array,[0]);put(21,Uint32Array,[0]);
  blocks[25]=Buffer.from('["object"]');put(26,Uint32Array,[0]);put(27,Float64Array,[0,0,0,2,3,4]);put(28,Uint32Array,[0]);
  const header=Buffer.alloc(236);header.writeUInt32LE(12);let offset=236;
  blocks.forEach((block,i)=>{header.writeUInt32LE(offset,4+i*8);header.writeUInt32LE(block.length,8+i*8);offset+=block.length;});
  return Buffer.concat([header,...blocks]);
}
test('inspection computes actual triangle and entity dimensions',()=>{
 const r=inspectXkt(fixture());assert.equal(r.entities,1);assert.equal(r.triangles,1);assert.ok(Math.abs(r.objectDiagonal.max-Math.sqrt(13))<1e-12);
});
test('inspection rejects bad vertex references and unsupported layouts',()=>{
 assert.throws(()=>inspectXkt(fixture(true)),/outside/);
 const b=fixture();b.writeUInt32LE(10,0);assert.throws(()=>inspectXkt(b),/v12/);
 const c=fixture();c.writeUInt32LE(0xffffffff,4+4*8);assert.throws(()=>inspectXkt(c),/bounds/);
});
