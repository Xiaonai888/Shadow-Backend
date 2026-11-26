import test from 'node:test'
import assert from 'node:assert/strict'
import {createPromotionAlertDelivery,formatPromotionAlert} from '../src/services/telegramPromotion/alertDelivery.service.js'
const start=Date.parse('2026-11-26T18:02:00+07:00')
const row={language:'km',worker_state:'stale',missing_events:2,failed_posts:0,uncertain_posts:1}
function fixture({responses=[{ready:true,rows:[row]}],sendResult={ok:true,result:{message_id:42}},configured=true,chatId='-1001234567890',throwSend=false}={}){
 let now=start,n=0;const claims=[],writes=[],messages=[],errors=[]
 const db={async rpc(name,args){claims.push([name,args]);return {data:responses[Math.min(n++,responses.length-1)]}},from(){return {update(value){writes.push(value);return this},eq(){return this},select(){return this},async maybeSingle(){return {data:{checkpoint_at:'ok'}}}}}}
 const alert=createPromotionAlertDelivery(db,{clock:()=>now,configured:()=>configured,chatId:()=>chatId,send:async(...args)=>{messages.push(args);if(throwSend)throw Error('123:secret');return sendResult},onError:e=>errors.push(e)})
 return {alert,claims,writes,messages,errors,advance:ms=>now+=ms}
}
test('one digest per checkpoint, sent to explicit separate chat',async()=>{const f=fixture();assert.equal(await f.alert.pulse(),true);assert.equal(f.claims[0][1].p_checkpoint,'2026-11-26T11:00:00.000Z');assert.equal(f.messages[0][1].chat_id,'-1001234567890');assert.equal(f.writes[0].status,'sent');f.advance(600000);assert.equal(await f.alert.pulse(),false);assert.equal(f.claims.length,1)})
test('no notification when watchdog has no problems',async()=>{const f=fixture({responses:[{ready:true,rows:[]}]});assert.equal(await f.alert.pulse(),false);assert.equal(f.messages.length,0);assert.equal(f.writes.length,0)})
test('wait for watchdog record, retry at bounded interval',async()=>{const f=fixture({responses:[{ready:false,rows:[]},{ready:true,rows:[row]}]});await f.alert.pulse();f.advance(599999);await f.alert.pulse();assert.equal(f.claims.length,1);f.advance(1);assert.equal(await f.alert.pulse(),true)})
test('uncertain send is quarantined without retry',async()=>{const f=fixture({throwSend:true});assert.equal(await f.alert.pulse(),false);assert.equal(f.writes[0].status,'uncertain');assert.equal(f.writes[0].last_error,'[redacted]');f.advance(600000);await f.alert.pulse();assert.equal(f.messages.length,1)})
test('no admin chat or token means no database query',async()=>{for(const f of [fixture({configured:false}),fixture({chatId:''})]){await f.alert.pulse();assert.equal(f.claims.length,0)}})
test('concurrent pulses do not issue duplicate claims',async()=>{const f=fixture();await Promise.all([f.alert.pulse(),f.alert.pulse(),f.alert.pulse()]);assert.equal(f.claims.length,1);assert.equal(f.messages.length,1)})
test('digest labels historical data and escapes HTML',()=>{const s=formatPromotionAlert(start,[{...row,worker_state:'<error>'}]);assert.match(s,/Historical watchdog snapshot/);assert.match(s,/&lt;error&gt;/)})
