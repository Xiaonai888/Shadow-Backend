import test from 'node:test'
import assert from 'node:assert/strict'
import {parseEventDestination,isEventChatId,createEventDestinationVerifier} from '../services/telegramEvent/destinations.service.js'
const token='123456:TEST_SECRET'
const channel={id:-1001234567890,type:'channel',title:'Channel'}
const group={id:-123456789,type:'group',title:'Group',permissions:{can_send_messages:true,can_send_photos:true}}
const supergroup={...group,id:-1001234567891,type:'supergroup'}
function fake({chatMap={},memberMap={},reject=false}={}){
  const calls=[]
  const fetchImpl=async(url,opts)=>{
    const method=url.split('/').at(-1),body=JSON.parse(opts.body)
    calls.push({method,body})
    if(reject)throw Error(token)
    const result=method==='getMe'?{id:1,is_bot:true}:method==='getChat'?chatMap[body.chat_id]:{user:{id:1},...memberMap[body.chat_id]}
    return {ok:!!result,status:result?200:400,json:async()=>({ok:!!result,result})}
  }
  return {calls,verify:createEventDestinationVerifier({token,fetchImpl})}
}
test('public links and safe negative IDs',()=>{
  for(const [input,expected] of [['https://t.me/ShadowChannel','@ShadowChannel'],['t.me/ShadowGroup/','@ShadowGroup'],['@ShadowGroup','@ShadowGroup'],['-12345','-12345'],['',''],[null,'']])assert.equal(parseEventDestination(input),expected||null)
  assert.equal(isEventChatId('-1001234567890'),true)
  assert.equal(isEventChatId('-9007199254740992'),false)
})
test('reject private links and unrelated URLs',()=>{for(const input of ['https://t.me/+secret','https://t.me/joinchat/secret','https://t.me/c/123/4','https://evil.example/ShadowGroup','https://t.me/ShadowGroup/1','https://t.me/ShadowGroup?x=1','123','-0'])assert.throws(()=>parseEventDestination(input))})
test('empty fields do not call Telegram',async()=>{const {verify,calls}=fake();assert.deepEqual(await verify({channel:'',group:''}),{channel:null,group:null});assert.equal(calls.length,0)})
test('both destinations resolve independently, one getMe',async()=>{const {verify,calls}=fake({chatMap:{'@ShadowChannel':channel,'@ShadowGroup':group},memberMap:{[channel.id]:{status:'administrator',can_post_messages:true},[group.id]:{status:'member'}}});assert.deepEqual(await verify({channel:'@ShadowChannel',group:'@ShadowGroup'}),{channel:{id:String(channel.id),name:'Channel',type:'channel'},group:{id:String(group.id),name:'Group',type:'group'}});assert.equal(calls.filter(x=>x.method==='getMe').length,1)})
test('group only supports basic group and supergroup',async()=>{for(const chat of [group,supergroup]){const {verify}=fake({chatMap:{[chat.id]:chat},memberMap:{[chat.id]:{status:'member'}}});const result=await verify({group:String(chat.id)});assert.equal(result.channel,null);assert.equal(result.group.id,String(chat.id))}})
test('channel only',async()=>{const {verify}=fake({chatMap:{[channel.id]:channel},memberMap:{[channel.id]:{status:'administrator',can_post_messages:true}}});assert.equal((await verify({channel:String(channel.id)})).group,null)})
test('reject swapped group and channel',async()=>{const {verify}=fake({chatMap:{'@ShadowGroup':group}});await assert.rejects(verify({channel:'@ShadowGroup'}),{code:'EVENT_DESTINATION_WRONG_TYPE'})})
test('reject channel bot without posting permission',async()=>{const {verify}=fake({chatMap:{[channel.id]:channel},memberMap:{[channel.id]:{status:'administrator',can_post_messages:false}}});await assert.rejects(verify({channel:String(channel.id)}),{code:'EVENT_DESTINATION_PERMISSION'})})
test('reject group bot without photo permission',async()=>{const {verify}=fake({chatMap:{[group.id]:{...group,permissions:{can_send_messages:true,can_send_photos:false}}},memberMap:{[group.id]:{status:'member'}}});await assert.rejects(verify({group:String(group.id)}),{code:'EVENT_DESTINATION_PERMISSION'})})
test('network failure never exposes token',async()=>{const {verify}=fake({reject:true});await assert.rejects(verify({group:'@ShadowGroup'}),e=>e.code==='EVENT_DESTINATION_UNAVAILABLE'&&!e.message.includes(token))})

import {createEventAdmin} from '../services/telegramEvent/admin.service.js'
import {createTelegramEventRuntime} from '../services/telegramEvent/runtime.service.js'
import {buildEventTelegramPayload,sendEventTelegram} from '../services/telegramEvent/telegram.service.js'

const version='2026-11-27T00:00:00.000Z'
function fakeStore({conflict=false}={}){
  const calls=[]
  const db={rpc:()=>assert.fail('unexpected RPC'),from(table){
    assert.equal(table,'telegram_event_channels')
    const row={}
    return {update(patch){calls.push(['update',patch]);Object.assign(row,patch);return this},eq(key,value){calls.push(['eq',key,value]);if(key==='language')row.language=value;return this},select(fields){calls.push(['select',fields]);return this},maybeSingle:async()=>({data:conflict?null:{...row,updated_at:version}}),order:async()=>({data:[]})}
  }}
  return {db,calls}
}
test('settings update is language scoped and atomic for both targets',async()=>{
  const {db,calls}=fakeStore();let wakes=0
  const admin=createEventAdmin(db,{verifyDestinations:async input=>{assert.deepEqual(input,{channel:'@ShadowChannel',group:'-123456789'});return {channel:{id:String(channel.id),name:'Channel'},group:{id:String(group.id),name:'Group'}}},wake:()=>wakes++})
  const row=await admin.updateDestinations('km',{channel:'@ShadowChannel',group:'-123456789',updated_at:version})
  assert.equal(row.channel_id,String(channel.id));assert.equal(row.group_id,String(group.id));assert.equal(row.enabled,true);assert.equal(wakes,1)
  assert.deepEqual(calls.slice(1,3),[['eq','language','km'],['eq','updated_at',version]])
})
test('group only, then clear both without token or Telegram calls',async()=>{
  const {db,calls}=fakeStore();const admin=createEventAdmin(db,{verifyDestinations:async input=>({channel:null,group:input.group?{id:String(group.id),name:'Group'}:null})})
  assert.equal((await admin.updateDestinations('en',{channel:null,group:String(group.id),updated_at:version})).enabled,false)
  const row=await admin.updateDestinations('en',{channel:null,group:null,updated_at:version});assert.equal(row.group_id,null);assert.equal(row.channel_id,null);assert.equal(row.enabled,false);assert.equal(calls.filter(x=>x[0]==='update').length,2)
})
test('invalid or incomplete settings do not verify or write',async()=>{
  const admin=createEventAdmin({from:()=>assert.fail('database called')},{verifyDestinations:()=>assert.fail('Telegram called')})
  for(const [language,input] of [['xx',{channel:null,group:null,updated_at:version}],['km',{channel:null,updated_at:version}],['km',{channel:null,group:null,updated_at:'invalid'}],['km',{channel:null,group:null,updated_at:version,enabled:true}]])await assert.rejects(admin.updateDestinations(language,input),{status:400})
})
test('verification failure prevents writes and stale settings do not wake',async()=>{
  const {db,calls}=fakeStore({conflict:true});const failed=createEventAdmin(db,{verifyDestinations:async()=>{throw new Error('verification failed')}})
  await assert.rejects(failed.updateDestinations('km',{channel:null,group:null,updated_at:version}),/verification failed/);assert.equal(calls.length,0)
  const admin=createEventAdmin(db,{verifyDestinations:async()=>({channel:null,group:null}),wake:()=>assert.fail('wake called')})
  await assert.rejects(admin.updateDestinations('km',{channel:null,group:null,updated_at:version}),{code:'EVENT_CONFLICT'})
})
test('runtime uses actual verifier even with scheduler disabled',async()=>{
  const {db,calls}=fakeStore();let requests=0
  const runtime=createTelegramEventRuntime({db,env:{TELEGRAM_EVENT_ENABLED:'false',TELEGRAM_EVENT_BOT_TOKEN:token},destinationFetch:async(url,opts)=>{
    requests++;const method=url.split('/').at(-1);const body=JSON.parse(opts.body)
    const result=method==='getMe'?{id:1,is_bot:true}:method==='getChat'?group:{user:{id:1},status:'member'}
    if(method==='getChat')assert.equal(body.chat_id,String(group.id))
    return {ok:true,status:200,json:async()=>({ok:true,result})}
  }})
  assert.equal(runtime.enabled(),false);const row=await runtime.admin.updateDestinations('km',{channel:null,group:String(group.id),updated_at:version});assert.equal(row.group_id,String(group.id));assert.equal(requests,3);assert.equal(calls.filter(x=>x[0]==='update').length,1)
})
test('transport supports basic group and supergroup but not invalid type or personal ID',async()=>{
  for(const chat of [group,supergroup]){
    const job={destination_kind:'group',channel_id:String(chat.id),message:'Event'}
    assert.equal(buildEventTelegramPayload(job).payload.chat_id,String(chat.id))
    const sent=await sendEventTelegram({token,job,fetchImpl:async(url,opts)=>{assert.ok(url.endsWith('/sendMessage'));assert.equal(JSON.parse(opts.body).chat_id,String(chat.id));return {ok:true,status:200,json:async()=>({ok:true,result:{message_id:42,chat:{id:chat.id}}})}}})
    assert.equal(sent.messageId,42)
  }
  for(const job of [{destination_kind:'channel',channel_id:String(group.id)},{destination_kind:'group',channel_id:'12345'},{destination_kind:'unknown',channel_id:String(group.id)}])assert.throws(()=>buildEventTelegramPayload({...job,message:'Event'}),{code:'INVALID_PAYLOAD'})
})
test('history includes destination kind without additional lookup',async()=>{
  let count=0;const db={from(table){assert.equal(table,'telegram_event_history');count++;return {select(fields){assert.ok(fields.includes('destination_kind'));return this},eq(){return this},order(){return this},range:async()=>({data:[{destination_kind:'group'}]})}}}
  const admin=createEventAdmin(db);const data=await admin.history({language:'km'});assert.equal(data.items[0].destination_kind,'group');assert.equal(count,1)
})

test('verification is sequential and retries only failed lookup',async()=>{
  const calls=[];let active=0,failed=false
  const verify=createEventDestinationVerifier({token,fetchImpl:async(url,opts)=>{
    const method=url.split('/').at(-1),body=JSON.parse(opts.body)
    calls.push([method,body.chat_id??null]);assert.equal(++active,1)
    try{
      await new Promise(resolve=>setTimeout(resolve,5))
      if(method==='getChat'&&body.chat_id==='@ShadowGroup'&&!failed){failed=true;throw Object.assign(new TypeError('fetch failed'),{cause:{code:'ETIMEDOUT'}})}
      const result=method==='getMe'?{id:1,is_bot:true}:method==='getChat'?(body.chat_id==='@ShadowChannel'?channel:group):{user:{id:1},status:'administrator',can_post_messages:true}
      return {ok:true,status:200,json:async()=>({ok:true,result})}
    }finally{active--}
  }})
  const result=await verify({channel:'@ShadowChannel',group:'@ShadowGroup'})
  assert.equal(result.channel.id,String(channel.id));assert.equal(result.group.id,String(group.id))
  assert.deepEqual(calls,[['getMe',null],['getChat','@ShadowChannel'],['getChatMember',String(channel.id)],['getChat','@ShadowGroup'],['getChat','@ShadowGroup'],['getChatMember',String(group.id)]])
})
test('persistent timeout retries once and reports safe method and cause',async()=>{
  let calls=0
  const verify=createEventDestinationVerifier({token,fetchImpl:async()=>{calls++;throw Object.assign(new Error(token),{cause:{code:'ETIMEDOUT'}})}})
  await assert.rejects(verify({group:'@ShadowGroup'}),e=>e.code==='EVENT_DESTINATION_UNAVAILABLE'&&e.message.includes('Bot getMe')&&e.message.includes('ETIMEDOUT')&&!e.message.includes(token));assert.equal(calls,2)
})
test('HTTP 429 and 401 do not retry',async()=>{
  for(const status of [429,401]){
    let calls=0
    const verify=createEventDestinationVerifier({token,fetchImpl:async()=>{calls++;return {status,ok:false,json:async()=>({ok:false,error_code:status})}}})
    await assert.rejects(verify({group:'@ShadowGroup'}),e=>e.message.includes(String(status)));assert.equal(calls,1)
  }
})
test('temporary HTTP 503 recovers without repeating successful lookups',async()=>{
  let calls=0
  const verify=createEventDestinationVerifier({token,fetchImpl:async(url)=>{
    calls++;const method=url.split('/').at(-1)
    if(calls===1)return {ok:false,status:503,json:async()=>({ok:false})}
    const result=method==='getMe'?{id:1,is_bot:true}:method==='getChat'?group:{user:{id:1},status:'member'}
    return {ok:true,status:200,json:async()=>({ok:true,result})}
  }})
  assert.equal((await verify({group:String(group.id)})).group.id,String(group.id));assert.equal(calls,4)
})
