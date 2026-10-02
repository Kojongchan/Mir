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

test('overview eligibility rejects missing coverage, inflated assets and unknown policies', () => {
 const valid={policy:'component-border-v1',members:329,byteLength:4000};
 assert.equal(lib.canUseOverview(valid,9000),true);
 for (const change of [{members:undefined},{members:0},{members:1.5},{byteLength:NaN},{byteLength:10000},{policy:'legacy'}])
  assert.equal(lib.canUseOverview({...valid,...change},9000),false);
});
test('merged light v2 is an accepted overview policy; the far level is not a pair', () => {
 assert.equal(lib.canUseOverview({policy:'merged-light-v2',members:12,byteLength:4000},9000),true);
 assert.equal(lib.canUseOverview({policy:'merged-far-v1',members:12,byteLength:4000},9000),false);
});
test('detail admission uses distance to actual box, including long bridges and large coordinates', () => {
 assert.equal(lib.needsDetail([500000,0,0],[499999,-1,-1,510000,1,1]),true);
 assert.equal(lib.needsDetail([0,0,0],[200,-1,-1,10000,1,1]),false);
 assert.equal(lib.needsDetail([0,0,0],[0,0,0,NaN,1,1]),false);
});
