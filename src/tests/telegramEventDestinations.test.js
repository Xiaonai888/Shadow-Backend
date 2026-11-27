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
