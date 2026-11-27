import test from 'node:test'
import assert from 'node:assert/strict'
import {createPromotionScheduler} from '../src/services/telegramPromotion/scheduler.service.js'
import {createPromotionIntegrationV2} from '../src/services/telegramPromotion/integrationV2.service.js'
import {promotionSlotsV2,nextPromotionSlotV2} from '../src/services/telegramPromotion/scheduleV2.service.js'
const now=Date.parse('2026-11-27T21:00:00+07:00')
const iso=new Date(now).toISOString()
function fixture({language='km',modern=true,states=[{}],editAt=null,editState='edited',more=false,enabled=true,token='123:abcdefghijk'}={}){
  const calls=[];let index=0
  const settings={language,enabled:true,channel_id:'-100123',enabled_at:'2026-11-26T00:00:00+07:00',schedule:[{day:5,time:'19:00',kind:'short'}]}
  const v2={supports:l=>['km','en'].includes(l),prepare:async()=>calls.push('v2:prepare'),optional:{enqueue:async({slot})=>{calls.push(`v2:slot:${slot.slotKey}`);return 'job'}},worker:{run:async()=>{calls.push('v2:send');return {state:'sent'}}},updateQueue:{nextEditDue:async()=>{calls.push('edit:due');return editAt}},editWorker:{run:async()=>{calls.push('edit:run');editAt=null;return {state:editState}}},slots:promotionSlotsV2,nextSlot:nextPromotionSlotV2}
  const scheduler=createPromotionScheduler({queue:{settings:async()=>{calls.push('settings');return [settings]}},source:{},candidates:{enqueue:async()=>{calls.push('legacy:slot');return 'legacy'}},worker:{run:async()=>{calls.push('legacy:send');return {state:'sent'}}},recovery:{step:async()=>({more}),due:async()=>states[Math.min(index++,states.length-1)]},prepare:async()=>calls.push('legacy:prepare'),clock:()=>now,token:()=>token,enabled:()=>enabled,monitor:{heartbeat:async(l,ok)=>calls.push(`heartbeat:${l}:${ok}`)},v2:modern?v2:null})
  return {scheduler,calls}
}
test('V2 update preparation and send outrank evening recommendation and edit',async()=>{
  const {scheduler,calls}=fixture({states:[{event_due_at:iso},{queue_due_at:iso,update_waiting:true,update_ready:true},{}],editAt:iso});await scheduler.tick();assert.ok(calls.includes('v2:prepare'));assert.ok(calls.includes('v2:send'));assert.ok(!calls.includes('edit:run'));assert.ok(!calls.some(x=>x.includes(':slot')))
})
test('night group only enqueued once per slot per scheduler',async()=>{
  const {scheduler,calls}=fixture();await scheduler.tick();await scheduler.tick();assert.equal(calls.filter(x=>x==='v2:slot:2026-11-27T21:00').length,1);assert.ok(!calls.includes('legacy:slot'))
})
test('edits take priority over optional send and slot selection',async()=>{
  const {scheduler,calls}=fixture({states:[{queue_due_at:iso},{queue_due_at:new Date(now+300000).toISOString()}],editAt:iso});await scheduler.tick();assert.ok(calls.includes('edit:run'));assert.ok(!calls.includes('v2:send'));assert.ok(!calls.some(x=>x.includes(':slot')))
})
test('idle edit claim does not block optional delivery',async()=>{
  const {scheduler,calls}=fixture({states:[{queue_due_at:iso}],editAt:iso,editState:'idle'});await scheduler.tick();assert.ok(calls.includes('edit:run'));assert.ok(calls.includes('v2:send'))
})
test('recovery backlog blocks optional and edit processing',async()=>{
  const {scheduler,calls}=fixture({more:true,editAt:iso});assert.equal(await scheduler.tick(),5000);assert.ok(!calls.some(x=>x.includes(':slot')||x.startsWith('edit:')))
})
test('unsupported language keeps legacy scheduling and preparation',async()=>{
  const {scheduler,calls}=fixture({language:'zh',states:[{event_due_at:iso},{},{}]});await scheduler.tick();assert.ok(calls.includes('legacy:prepare'));assert.ok(calls.includes('legacy:slot'));assert.ok(!calls.some(x=>x.startsWith('edit:')||x.startsWith('v2:slot')))
})
test('feature switch off keeps legacy scheduler',async()=>{
  const {scheduler,calls}=fixture({modern:false,states:[{queue_due_at:iso}, {queue_due_at:iso},{}]});await scheduler.tick();assert.ok(calls.includes('legacy:slot'));assert.ok(calls.includes('legacy:send'));assert.ok(!calls.some(x=>x.startsWith('v2:')||x.startsWith('edit:')))
})
test('disabled runtime does not query',async()=>{
  const {scheduler,calls}=fixture({enabled:false});await scheduler.tick();assert.deepEqual(calls,[])
})
test('integration composes actual V2 modules without querying DB',()=>{
  const unexpected=()=>{throw new Error('unexpected database query')};const db={rpc:unexpected,from:unexpected};const queue={claim:unexpected,finish:unexpected};const source={load:unexpected,authorName:unexpected,dueEvents:unexpected,finishEvent:unexpected};const candidates={context:unexpected,validate:unexpected};const v2=createPromotionIntegrationV2({db,queue,source,candidates,token:()=>''});assert.equal(v2.supports('km'),true);assert.equal(v2.supports('en'),true);assert.equal(v2.supports('zh'),false);assert.equal(typeof v2.prepare,'function');assert.equal(typeof v2.worker.run,'function');assert.throws(()=>createPromotionIntegrationV2({db,queue,source,candidates,token:()=>'',safeCoverUrl:'http://invalid.example'}))
})
