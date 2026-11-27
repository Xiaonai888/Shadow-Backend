import test from 'node:test'
import assert from 'node:assert/strict'
import {createEventManual} from '../services/telegramEvent/manual.service.js'
const event='12345678-1234-4234-8234-123456789012'
const request='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const job='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const body={language:'km',request_id:request}
const ready={runtimeEnabled:()=>true,tokenConfigured:()=>true}
test('disabled runtime or missing token never queues',async()=>{
  for(const options of [{},{runtimeEnabled:()=>true},{tokenConfigured:()=>true}]){
    const post=createEventManual({rpc:()=>assert.fail('unexpected RPC')},options)
    await assert.rejects(post(event,body),e=>e.code==='EVENT_BOT_DISABLED')
  }
})
test('manual queue uses exact RPC contract and wakes after success',async()=>{
  const calls=[];const post=createEventManual({rpc:async(...args)=>{calls.push(args);return {data:job}}},{...ready,wake:()=>calls.push('wake')})
  assert.deepEqual(await post(event,body),{job_id:job,queued:true})
  assert.deepEqual(calls,[['telegram_event_manual_v1',{p_event:event,p_language:'km',p_request:request}],'wake'])
})
test('same request key is preserved for retry',async()=>{
  const keys=[];const post=createEventManual({rpc:async(_,args)=>{keys.push(args.p_request);return {data:job}}},ready)
  assert.deepEqual(await post(event,body),await post(event,body));assert.deepEqual(keys,[request,request])
})
test('invalid input never reaches database',async()=>{
  const post=createEventManual({rpc:()=>assert.fail('unexpected RPC')},ready)
  for(const input of [null,[],{...body,language:'xx'},{...body,request_id:'bad'},{...body,channel_id:'-100123456'}])await assert.rejects(post(event,input),e=>e.status===400)
  await assert.rejects(post('bad',body),e=>e.status===400)
})
test('known SQL errors preserve status and do not wake',async()=>{
  for(const [code,status] of [['EVENT_NOT_FOUND',404],['EVENT_CHANNEL_NOT_READY',409],['EVENT_NO_ENABLED_CONTENT',409],['EVENT_INVALID_STATUS',409],['EVENT_INVALID_INPUT',400]]){
    const post=createEventManual({rpc:async()=>({error:{message:code}})},{...ready,wake:()=>assert.fail('unexpected wake')})
    await assert.rejects(post(event,body),e=>e.code===code&&e.status===status)
  }
})
test('unknown SQL error is not presented as success',async()=>{
  const post=createEventManual({rpc:async()=>({error:{code:'XX000',message:'private details'}})},ready)
  await assert.rejects(post(event,body),/XX000/)
})
test('wake failure does not invalidate committed queue job',async()=>{
  const post=createEventManual({rpc:async()=>({data:job})},{...ready,wake:()=>{throw Error('wake failed')}})
  assert.deepEqual(await post(event,body),{job_id:job,queued:true})
})
