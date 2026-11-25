import test from 'node:test';
import assert from 'node:assert/strict';
import {checkStorageBudget,STORAGE_LIMIT_BYTES} from '../scripts/storage-budget.mjs';

test('includes every page and old-generation bytes before admitting a write',async()=>{
 const tokens=[];
 const result=await checkStorageBudget(async token=>{
  tokens.push(token);
  return token?{Contents:[{Size:2_000_000_000}],IsTruncated:false}:
   {Contents:[{Size:5_973_096_510}],IsTruncated:true,NextContinuationToken:'next'};
 },1_000_000_000);
 assert.deepEqual(tokens,[undefined,'next']);
 assert.equal(result.projectedBytes,8_973_096_510);
});
test('oversized write fails before upload; exact ceiling accepted',async()=>{
 const list=async()=>({Contents:[{Size:5_973_096_510}],IsTruncated:false});
 await assert.rejects(checkStorageBudget(list,4_000_000_000),/용량 제한/);
 assert.equal((await checkStorageBudget(list,STORAGE_LIMIT_BYTES-5_973_096_510)).projectedBytes,STORAGE_LIMIT_BYTES);
});
test('missing sizes, failed inventory and truncated pagination fail closed',async()=>{
 for(const page of [{Contents:[{}],IsTruncated:false},{Contents:[{Size:-1}],IsTruncated:false},
  {Contents:[],IsTruncated:true},{Contents:[]}])
  await assert.rejects(checkStorageBudget(async()=>page,10));
 await assert.rejects(checkStorageBudget(async()=>{throw Error('denied');},10),/denied/);
 await assert.rejects(checkStorageBudget(async()=>({Contents:[],IsTruncated:true,NextContinuationToken:'same'}),10),/pagination/);
 await assert.rejects(checkStorageBudget(async()=>({Contents:[],IsTruncated:false}),10,10_000_000_001),/budget/);
});
