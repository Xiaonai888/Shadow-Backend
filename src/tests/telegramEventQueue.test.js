import test from 'node:test'
import assert from 'node:assert/strict'
import { createEventQueue,eventBotKey,safeEventError } from '../services/telegramEvent/queue.service.js'
import { createEventWorker } from '../services/telegramEvent/worker.service.js'
import { createEventScheduler } from '../services/telegramEvent/scheduler.service.js'

const token='123456:example_token_for_test'
const job={id:'job',event_id:'event',language:'km',channel_id:'-100123456789',lease_id:'lease',attempts:1,message:'Hello',image_key:'key',image_url:'https://example.com/image.png',photo_bot_key:eventBotKey(token),photo_file_id:'cached'}
function fixture(send,overrides={}) {
  const calls=[]
  const queue={claim:async()=>job,finish:async(...args)=>{calls.push(args);return true},...overrides}
  return {worker:createEventWorker({queue,token,send}),calls}
}
test('queue calls SQL functions and keeps lease on finish',async()=>{
  const calls=[]
  const queue=createEventQueue({rpc:async(...args)=>{calls.push(args);return {data:true}}})
  await queue.prepare();await queue.claim();await queue.nextDue();await queue.manual('event','km','request');await queue.finish(job,'sent',{messageId:8,fileId:'new',botKey:eventBotKey(token)})
  assert.deepEqual(calls.map(c=>c[0]),['telegram_event_prepare_v1','telegram_event_claim_v1','telegram_event_next_due_v1','telegram_event_manual_v1','telegram_event_finish_v1'])
  assert.equal(calls[4][1].p_lease,'lease');assert.equal(calls[4][1].p_message_id,8)
})
test('successful delivery reuses photo and saves confirmed message ID',async()=>{
  const {worker,calls}=fixture(async p=>{assert.equal(p.fileId,'cached');return {messageId:7,fileId:'new'}})
  assert.equal((await worker.run()).state,'sent');assert.equal(calls[0][2].messageId,7);assert.equal(calls[0][2].fileId,'new')
})
test('invalid cached photo retries only once with source URL',async()=>{
  const tried=[];const {worker,calls}=fixture(async p=>{tried.push(p.fileId);if(p.fileId)throw Object.assign(new Error('Invalid file'),{status:400,code:'INVALID_FILE_ID'});return {messageId:7}})
  await worker.run();assert.deepEqual(tried,['cached',null]);assert.equal(calls[0][1],'sent')
})
test('network timeout becomes uncertain without resend',async()=>{
  let count=0;const {worker,calls}=fixture(async()=>{count++;throw Object.assign(new Error('timeout'),{uncertain:true})})
  assert.equal((await worker.run()).state,'uncertain');assert.equal(count,1);assert.equal(calls[0][1],'uncertain')
})
test('429 schedules safe retry',async()=>{
  const {worker,calls}=fixture(async()=>{throw Object.assign(new Error('rate limit'),{status:429,retryAfter:12})})
  assert.equal((await worker.run()).state,'retry');assert.equal(calls[0][2].retrySeconds,12)
})
test('403 fails without retry',async()=>{
  const {worker,calls}=fixture(async()=>{throw Object.assign(new Error('permission'),{status:403})})
  assert.equal((await worker.run()).state,'failed');assert.equal(calls[0][1],'failed')
})
test('missing message ID and lost lease require review',async()=>{
  const a=fixture(async()=>({}));assert.equal((await a.worker.run()).state,'uncertain')
  const b=fixture(async()=>({messageId:5}),{finish:async()=>false});assert.equal((await b.worker.run()).state,'uncertain')
})
test('bot token redaction',()=>assert.ok(!safeEventError(`https://api.telegram.org/bot${token}`).includes(token)))
test('disabled scheduler does not query database',async()=>{
  const fail=()=>{throw Error('Unexpected call')};const scheduler=createEventScheduler({queue:{prepare:fail,nextDue:fail},worker:{run:fail}})
  assert.equal(scheduler.start(),false);assert.equal(await scheduler.tick(),600000)
})
test('scheduler waits until next slot with capped idle interval',async()=>{
  const now=Date.parse('2026-11-29T01:00:00Z');let due=null;let prepared=0;let worked=0
  const scheduler=createEventScheduler({queue:{prepare:async()=>prepared++,nextDue:async()=>due},worker:{run:async()=>{worked++;return {state:'idle'}}},enabled:()=>true,clock:()=>now})
  assert.equal(await scheduler.tick(),600000);due=new Date(now+45000).toISOString();assert.equal(await scheduler.tick(),45000);due=new Date(now-1000).toISOString();assert.equal(await scheduler.tick(),1000);assert.equal(prepared,3);assert.equal(worked,3)
})
test('missing token never claims a job',async()=>{
  const fail=()=>{throw Error('Unexpected call')};const worker=createEventWorker({queue:{claim:fail,finish:fail},token:'',send:fail});assert.equal((await worker.run()).state,'disabled')
})
