import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const code=ts.transpileModule(fs.readFileSync('src/viewer/ViewerPresence.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const out={};new Function('exports',code)(out);
const {keepViewerPresent}=out;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
class Lock extends EventTarget { released=false; async release(){this.released=true;this.dispatchEvent(new Event('release'));} }
function setup(request){const doc=new EventTarget();doc.visibilityState='visible';const win=new EventTarget();let draws=0;const stop=keepViewerPresent(doc,win,request,()=>draws++);return{doc,win,stop,draws:()=>draws};}

test('visible idle viewer holds its lock, tab return reacquires and redraws once',async()=>{
 const locks=[];const v=setup(async()=>{const l=new Lock();locks.push(l);return l;});await tick();
 assert.equal(locks.length,1);assert.equal(locks[0].released,false);assert.equal(v.draws(),0);
 v.doc.visibilityState='hidden';v.doc.dispatchEvent(new Event('visibilitychange'));await tick();
 assert.equal(locks[0].released,true);assert.equal(v.draws(),0);
 v.doc.visibilityState='visible';v.doc.dispatchEvent(new Event('visibilitychange'));await tick();
 assert.equal(locks.length,2);assert.equal(v.draws(),1);
 v.stop();assert.equal(locks[1].released,true);v.win.dispatchEvent(new Event('focus'));assert.equal(v.draws(),1);
});
test('denied and unsupported wake locks do not prevent redraw or cause retries',async()=>{
 let attempts=0;const v=setup(async()=>{attempts++;throw new Error('denied');});await tick();assert.equal(attempts,1);
 v.win.dispatchEvent(new Event('focus'));await tick();assert.equal(v.draws(),1);assert.equal(attempts,2);v.stop();
 const u=setup(undefined);u.win.dispatchEvent(new Event('pageshow'));assert.equal(u.draws(),1);u.stop();
});
test('late lock acquisition after leaving page is released; concurrent requests are bounded',async()=>{
 let finish,requests=0;const v=setup(()=>{requests++;return new Promise(r=>finish=r);});
 v.win.dispatchEvent(new Event('focus'));v.win.dispatchEvent(new Event('pageshow'));assert.equal(requests,1);
 v.stop();const l=new Lock();finish(l);await tick();assert.equal(l.released,true);
});
