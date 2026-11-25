import { simplifyTileMesh } from './tile-lod.mjs';

/** Motion approximation directly from legacy XKT v12. Metadata, materials,
 * compressed textures, coordinates and IDs retain their original binary tables.
 * Reduced geometry uses flat shading during motion; detail normals stay intact.
 * Unsupported layouts return null, never a partial replacement. */
export async function buildCachedMotion(input) {
 const b=Buffer.from(input);
 if(b.length<236||b.readUInt32LE(0)!==12)return null;
 const raw=[];
 for(let s=0;s<29;s++){
  const o=b.readUInt32LE(4+s*8),n=b.readUInt32LE(8+s*8);
  if(o<236||o+n>b.length)throw Error('Invalid XKT table bounds');
  raw.push(b.subarray(o,o+n));
 }
 const read=(s,T)=>{if(raw[s].length%T.BYTES_PER_ELEMENT)throw Error('Invalid table alignment');return new T(Uint8Array.from(raw[s]).buffer);};
 const p=read(4,Uint16Array),normal=read(5,Int8Array),uv=read(7,Float32Array),idx=read(8,Uint32Array),edge=read(9,Uint32Array);
 const primitive=read(13,Uint8Array),pp=read(15,Uint32Array),np=read(16,Uint32Array),up=read(18,Uint32Array),ip=read(19,Uint32Array),ep=read(20,Uint32Array);
 const mg=read(21,Uint32Array),em=read(26,Uint32Array),boxes=read(27,Float64Array),te=read(28,Uint32Array);
 const ids=JSON.parse(raw[25].toString()),textureSet=read(23,Int32Array);
 if(new Set(mg).size!==mg.length||primitive.some(v=>v>1)||read(6,Uint8Array).length)return null;
 if(!Array.isArray(ids)||ids.length!==em.length||new Set(ids.map(String)).size!==ids.length||boxes.length!==te.length*6||[np,up,ip,ep,primitive].some(v=>v.length!==pp.length)||textureSet.length!==mg.length)throw Error('Invalid XKT layout');
 const scale=new Map();
 for(let t=0;t<te.length;t++){
  const size=[0,1,2].map(a=>boxes[t*6+a+3]-boxes[t*6+a]);
  if(!size.every(v=>Number.isFinite(v)&&v>=0))throw Error('Invalid tile extent');
  for(let e=te[t];e<(te[t+1]??em.length);e++)for(let m=em[e];m<(em[e+1]??mg.length);m++)scale.set(mg[m],size);
 }
 if(scale.size!==pp.length)return null;
 const span=(data,ptr,g)=>{const a=ptr[g],z=ptr[g+1]??data.length;if(a>z||z>data.length)throw Error('Invalid geometry span');return data.slice(a,z);};
 const arrays={p:[],n:[],u:[],i:[],e:[]},offsets={p:[],n:[],u:[],i:[],e:[]};
 let before=0,after=0,reducedMeshes=0;
 for(let g=0;g<pp.length;g++){
  let gp=span(p,pp,g),gn=span(normal,np,g),gu=span(uv,up,g),gi=span(idx,ip,g),ge=span(edge,ep,g);
  if(gp.length%3||gi.length%3||gn.length&&gn.length!==gp.length||gu.length&&gu.length!==gp.length/3*2)throw Error('Invalid vertex attributes');
  if(!gi.every(v=>v<gp.length/3))throw Error('Invalid index');
  before+=gi.length/3;
  // Welding positions makes hard-normal seams simplifiable. UV seams stay split.
  // Only the motion approximation drops vertex normals; idle detail is untouched.
  const reps=[],keys=new Map(),remap=new Uint32Array(gp.length/3),wp=[],wn=[];
  for(let v=0;v<remap.length;v++){
   const key=[gp[v*3],gp[v*3+1],gp[v*3+2],...(gu.length?[gu[v*2],gu[v*2+1]]:[])].join(',');
   let next=keys.get(key);
   if(next===undefined){next=reps.length;keys.set(key,next);reps.push(v);for(let a=0;a<3;a++){wp.push(gp[v*3+a]/65535*scale.get(g)[a]);wn.push(a===2?1:0);}}
   remap[v]=next;
  }
  const r=await simplifyTileMesh(Float32Array.from(wp),Float32Array.from(wn),Uint32Array.from(gi,v=>remap[v]));
  if(r.reduced){
   const selected=Uint32Array.from(r.sourceIndices,v=>reps[v]),newIndex=new Map(),vp=[],vu=[];
   const compact=Uint32Array.from(selected,v=>{if(!newIndex.has(v)){newIndex.set(v,newIndex.size);vp.push(gp[v*3],gp[v*3+1],gp[v*3+2]);if(gu.length)vu.push(gu[v*2],gu[v*2+1]);}return newIndex.get(v);});
   gp=Uint16Array.from(vp);gu=Float32Array.from(vu);gi=compact;gn=new Int8Array();ge=new Uint32Array();reducedMeshes++;
  }
  after+=gi.length/3;
  for(const [key,values] of Object.entries({p:gp,n:gn,u:gu,i:gi,e:ge})){offsets[key].push(arrays[key].length);for(const v of values)arrays[key].push(v);}
 }
 if(!before||after>=before*.75)return null;
 for(const [slot,key,T] of [[4,'p',Uint16Array],[5,'n',Int8Array],[7,'u',Float32Array],[8,'i',Uint32Array],[9,'e',Uint32Array]])raw[slot]=Buffer.from(T.from(arrays[key]).buffer);
 for(const [slot,key] of [[15,'p'],[16,'n'],[18,'u'],[19,'i'],[20,'e']])raw[slot]=Buffer.from(Uint32Array.from(offsets[key]).buffer);
 // All table starts aligned for Float64Array in the SDK parser.
 const head=Buffer.alloc(236),parts=[head];head.writeUInt32LE(12,0);let length=236;
 raw.forEach((part,s)=>{const pad=(8-length%8)%8;if(pad){parts.push(Buffer.alloc(pad));length+=pad;}head.writeUInt32LE(length,4+s*8);head.writeUInt32LE(part.length,8+s*8);parts.push(part);length+=part.length;});
 return {bytes:Buffer.concat(parts),members:ids.length,detailTriangles:before,triangles:after,reducedMeshes,policy:'component-border-v1'};
}
