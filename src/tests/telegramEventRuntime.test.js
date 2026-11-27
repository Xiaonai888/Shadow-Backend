import test from 'node:test'
import assert from 'node:assert/strict'
import {buildEventTelegramPayload,sendEventTelegram} from '../services/telegramEvent/telegram.service.js'
import {createTelegramEventRuntime} from '../services/telegramEvent/runtime.service.js'

const token='123456:example_test_only'
const channel='-100123456789'
const job={channel_id:channel,message:'សាកល្បង <3 & hello',image_url:'https://example.com/cover.png',image_key:'cover',button_label:'Join',button_url:'https://example.com/event'}
const response=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body})
const success={ok:true,result:{message_id:12,chat:{id:Number(channel)},photo:[{file_id:'small'},{file_id:'large'}]}}

test('photo payload uses literal text, cached photo and optional button',()=>{
  const p=buildEventTelegramPayload(job,'cached')
  assert.equal(p.method,'sendPhoto');assert.equal(p.payload.photo,'cached');assert.equal(p.payload.caption,job.message);assert.equal(p.payload.parse_mode,undefined);assert.equal(p.payload.reply_markup.inline_keyboard[0][0].url,job.button_url)
})
test('text only and image only messages',()=>{
  const text=buildEventTelegramPayload({...job,image_url:null,button_label:null,button_url:null})
  assert.equal(text.method,'sendMessage');assert.equal(text.payload.text,job.message);assert.equal(text.payload.reply_markup,undefined)
  assert.equal(buildEventTelegramPayload({...job,message:''}).payload.caption,undefined)
})
test('invalid payload fails before network',async()=>{
  for(const bad of [{...job,channel_id:'@wrong'},{...job,image_url:'http://example.com/a'},{...job,button_url:'javascript:alert(1)'},{...job,image_url:null,message:''},{...job,message:'x'.repeat(1001)}]) await assert.rejects(sendEventTelegram({token,job:bad,fetchImpl:()=>assert.fail('network called')}),{status:400,code:'INVALID_PAYLOAD'})
})
test('confirmed photo response returns message and largest file id',async()=>{
  const result=await sendEventTelegram({token,job,fetchImpl:async(url,opts)=>{assert.equal(url,`https://api.telegram.org/bot${token}/sendPhoto`);assert.equal(opts.redirect,'error');assert.equal(JSON.parse(opts.body).photo,job.image_url);return response(success)}})
  assert.deepEqual(result,{messageId:12,fileId:'large'})
})
test('confirmed text response returns no file id',async()=>{
  const result=await sendEventTelegram({token,job:{...job,image_url:null},fetchImpl:async(url)=>{assert.ok(url.endsWith('/sendMessage'));return response({ok:true,result:{message_id:9,chat:{id:Number(channel)}}})}})
  assert.deepEqual(result,{messageId:9,fileId:null})
})
test('only known invalid cached identifier permits photo fallback',async()=>{
  for(const [description,code] of [['Bad Request: wrong file identifier/HTTP URL specified','INVALID_FILE_ID'],['Bad Request: chat not found',null]])await assert.rejects(sendEventTelegram({token,job,fileId:'cached',fetchImpl:async()=>response({ok:false,error_code:400,description},400)}),{status:400,code,uncertain:false})
})
test('confirmed rate limit exposes retry delay',async()=>{
  await assert.rejects(sendEventTelegram({token,job,fetchImpl:async()=>response({ok:false,error_code:429,parameters:{retry_after:25}},429)}),{status:429,retryAfter:25,uncertain:false})
})
test('network, server, malformed and wrong channel results are uncertain',async()=>{
  const cases=[async()=>{throw Error(token)},async()=>response({ok:false,error_code:500},500),async()=>response({},429),async()=>response({ok:true,result:{message_id:3,chat:{id:1}}})]
  for(const fetchImpl of cases) await assert.rejects(sendEventTelegram({token,job,fetchImpl}),e=>e.uncertain===true&&!e.message.includes(token))
})
test('disabled runtime does not query or schedule with missing token',async()=>{
  const runtime=createTelegramEventRuntime({db:{rpc:()=>assert.fail('database called')},env:{TELEGRAM_EVENT_ENABLED:'true'}})
  assert.equal(runtime.enabled(),false);assert.equal(runtime.start(),false);assert.equal(runtime.wake(),false);assert.equal(await runtime.tick(),600000)
})
test('runtime connects real worker and queue with simulated database',async()=>{
  const calls=[];const id='11111111-1111-4111-8111-111111111111';const now=Date.parse('2026-11-29T01:00:00Z')
  const db={rpc:async(name,args)=>{calls.push([name,args]);return {data:name.endsWith('claim_v1')?{...job,id,lease_id:id,language:'km'}:name.endsWith('next_due_v1')?new Date(now+45000).toISOString():true}}}
  const runtime=createTelegramEventRuntime({db,env:{TELEGRAM_EVENT_ENABLED:'true',TELEGRAM_EVENT_BOT_TOKEN:token},clock:()=>now,send:async({job:claimed,token:secret})=>{assert.equal(secret,token);assert.equal(claimed.id,id);return {messageId:12,fileId:'new'}}})
  assert.equal(await runtime.tick(),45000);assert.deepEqual(calls.map(x=>x[0]),['telegram_event_prepare_v1','telegram_event_claim_v1','telegram_event_finish_v1','telegram_event_next_due_v1']);assert.equal(calls[2][1].p_message_id,12);assert.equal(calls[2][1].p_outcome,'sent')
})
test('runtime manual API queues only selected language using same request ID',async()=>{
  const id='11111111-1111-4111-8111-111111111111';const calls=[]
  const runtime=createTelegramEventRuntime({db:{rpc:async(name,args)=>{calls.push([name,args]);return {data:id}}},env:{TELEGRAM_EVENT_ENABLED:'true',TELEGRAM_EVENT_BOT_TOKEN:token}})
  assert.deepEqual(await runtime.postNow(id,{language:'ja',request_id:id}),{job_id:id,queued:true});assert.deepEqual(calls,[['telegram_event_manual_v1',{p_event:id,p_language:'ja',p_request:id}]])
})
