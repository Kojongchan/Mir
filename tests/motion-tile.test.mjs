import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const code = ts.transpileModule(fs.readFileSync('src/viewer/MotionTile.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
const lib={};new Function('exports',code)(lib);
const model=(prefix,ids,box=[0,0,0,20,20,1])=>({aabb:box,objects:Object.fromEntries(ids.map(id=>[prefix+id,{id:prefix+id,originalSystemId:id}]))});
test('reject missing members and misplaced decoded geometry',()=>{
 const d=model('detail',['1','2']);
 assert.ok(lib.motionPairMatches(d,model('proxy',['2','1'])));
 assert.equal(lib.motionPairMatches(d,model('proxy',['1'])),false);
 assert.equal(lib.motionPairMatches(d,model('proxy',['1','3'])),false);
 assert.equal(lib.motionPairMatches(d,model('proxy',['1','2'],[200,0,0,220,20,1])),false);
});
test('no blank frame while proxy loads, fails, or motion ends; viewport culling applies to both',()=>{
 for(const ready of [false,true])for(const moving of [false,true]) {
  const v=lib.motionTileVisibility(true,moving,ready);
  assert.notEqual(v.detailCulled,v.proxyCulled);
  if(!ready||!moving)assert.equal(v.detailCulled,false);
 }
 assert.deepEqual(lib.motionTileVisibility(false,true,true),{detailCulled:true,proxyCulled:true});
});
