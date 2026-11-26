import test from 'node:test'
import assert from 'node:assert/strict'
import { planRecovery } from '../src/services/telegramPromotion/recovery.service.js'
import { createPromotionScheduler,nextPromotionSlot } from '../src/services/telegramPromotion/scheduler.service.js'
import { PROMOTION_SCHEDULE } from '../src/services/telegramPromotion/policy.service.js'

const NOW=Date.parse('2026-11-26T12:00:00+07:00')
const settings={language:'km',enabled:true,channel_id:'-100123',enabled_at:'2026-11-26T08:00:00+07:00',schedule:PROMOTION_SCHEDULE}
const dueTime=new Date(NOW).toISOString()
function fixture({states=[{}],more=false,enabled=true,list=[settings],token='123:abcdefghijk',enqueueResult='job'}={}) {
  const calls=[]
  let n=0
  const scheduler=createPromotionScheduler({
    queue:{settings:async()=>{calls.push('settings');return list}},source:{},
    candidates:{enqueue:async({slot})=>{calls.push(`slot:${slot.kind}`);return enqueueResult}},
    worker:{run:async()=>{calls.push('send');return {state:'sent'}}},
    recovery:{step:async()=>{calls.push('recover');return {more}},due:async()=>{calls.push('due');return states[Math.min(n++,states.length-1)]}},
    prepare:async()=>{calls.push('prepare')},enabled:()=>enabled,token:()=>token,clock:()=>NOW,
  })
  return {scheduler,calls}
}
test('recovery begins at activation day in Cambodia',()=>{
  const plan=planRecovery({},settings,NOW)
  assert.equal(plan.from,Date.parse('2026-11-26T00:00:00+07:00'))
  assert.equal(plan.to,NOW)
})
test('recovery resumes persisted keyset window',()=>{
  const from='2026-11-25T17:00:00Z',to='2026-11-26T04:00:00Z'
  const state={window_from:from,window_to:to,cursor_at:'2026-11-26T01:00:00Z',cursor_id:'id'}
  assert.deepEqual(planRecovery(state,settings,NOW),{from:Date.parse(from),to:Date.parse(to),after:{first_published_at:state.cursor_at,episode_id:'id'}})
})
test('recovery after downtime covers checkpoint plus one day overlap',()=>{
  const s={...settings,enabled_at:'2026-11-20T00:00:00+07:00'}
  const state={completed_through:'2026-11-23T12:00:00+07:00'}
  assert.equal(planRecovery(state,s,NOW).from,Date.parse('2026-11-22T12:00:00+07:00'))
})
test('recent checkpoint and disabled language need no recovery',()=>{
  assert.equal(planRecovery({completed_through:dueTime},settings,NOW),null)
  assert.equal(planRecovery({}, {...settings,enabled:false},NOW),null)
})
test('weekly schedule finds next Cambodia time',()=>{
  assert.equal(nextPromotionSlot(PROMOTION_SCHEDULE,NOW),Date.parse('2026-11-26T19:00:00+07:00'))
  assert.equal(nextPromotionSlot([],NOW),Infinity)
})
test('disabled system does not query database',async()=>{
  const {scheduler,calls}=fixture({enabled:false}); await scheduler.tick(); assert.deepEqual(calls,[])
})
test('missing token or disabled language does not recover or send',async()=>{
  const {scheduler,calls}=fixture({token:'',list:[settings,{...settings,language:'en',enabled:false}]}); await scheduler.tick(); assert.deepEqual(calls,['settings'])
})
test('update preparation and sending take priority over scheduled slot',async()=>{
  const {scheduler,calls}=fixture({states:[{event_due_at:dueTime},{queue_due_at:dueTime,update_waiting:true,update_ready:true},{}]});await scheduler.tick()
  assert.deepEqual(calls,['settings','recover','due','prepare','due','send','due'])
})
test('scheduled post waits while pending events still need preparation',async()=>{
  const {scheduler,calls}=fixture({states:[{event_due_at:dueTime,queue_due_at:dueTime}]});const delay=await scheduler.tick();assert.ok(delay<=5000);assert.ok(!calls.includes('send'));assert.ok(!calls.some(c=>c.startsWith('slot:')))
})
test('scheduled slot is enqueued once per process, then can send',async()=>{
  const {scheduler,calls}=fixture({states:[{},{queue_due_at:dueTime},{}]});await scheduler.tick();await scheduler.tick();assert.equal(calls.filter(c=>c==='slot:completed').length,1);assert.equal(calls.filter(c=>c==='send').length,1)
})
test('recovery backlog blocks optional promotion and continues quickly',async()=>{
  const {scheduler,calls}=fixture({more:true});assert.equal(await scheduler.tick(),5000);assert.ok(!calls.some(c=>c.startsWith('slot:')))
})
test('unsuccessful slot selection is not repeated on each wake',async()=>{
  const {scheduler,calls}=fixture({enqueueResult:null});await scheduler.tick();await scheduler.tick();assert.equal(calls.filter(c=>c==='slot:completed').length,1)
})
