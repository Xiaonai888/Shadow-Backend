import test from 'node:test'
import assert from 'node:assert/strict'
import {planRecovery,createPromotionRecovery} from '../src/services/telegramPromotion/recovery.service.js'
import {createPromotionScheduler} from '../src/services/telegramPromotion/scheduler.service.js'
const kh=t=>Date.parse(`${t}+07:00`)
const iso=t=>new Date(kh(t)).toISOString()
const settings={language:'km',enabled:true,channel_id:'-100123',enabled_at:iso('2026-11-25T08:00'),schedule:[{day:3,time:'19:00',kind:'completed'}]}
test('recovery switches to fixed checkpoints instead of six hour intervals',()=>{
  const state={completed_through:iso('2026-11-26T07:00')}
  assert.equal(planRecovery(state,settings,kh('2026-11-26T10:59')),null)
  assert.ok(planRecovery(state,settings,kh('2026-11-26T11:00')))
  assert.equal(planRecovery({completed_through:iso('2026-11-26T18:00')},settings,kh('2026-11-27T06:59')),null)
  assert.ok(planRecovery({completed_through:iso('2026-11-26T18:00')},settings,kh('2026-11-27T07:00')))
})
test('cached recovery wakes at next checkpoint',async()=>{
  let state={revision:0,completed_through:iso('2026-11-26T07:00')},reads=0,reconciles=0
  const db={rpc:async()=>({data:{}}),from:()=>({select:()=>({eq:()=>({single:async()=>{reads++;return {data:state}}})}),update:patch=>({eq:()=>({eq:()=>({select:()=>({maybeSingle:async()=>{state={...state,...patch};return {data:{language:'km'}}}})})})})})}
  const source={reconcilePage:async()=>{reconciles++;return {added:1,next:null}}}
  const recovery=createPromotionRecovery(db,source)
  await recovery.step(settings,kh('2026-11-26T10:58'))
  await recovery.step(settings,kh('2026-11-26T10:59'))
  assert.equal(reads,1)
  assert.equal(reconciles,0)
  await recovery.step(settings,kh('2026-11-26T11:00'))
  assert.equal(reconciles,1)
  assert.equal(state.completed_through,iso('2026-11-26T11:00'))
})
function fixture({now=kh('2026-11-26T07:00'),token='123:abcdefghijk',enabled=true,states=[{}],failure=false,monitorThrows=false}={}){
  const calls=[];let index=0
  const scheduler=createPromotionScheduler({queue:{settings:async()=>{calls.push('settings');return [settings]}},source:{},candidates:{enqueue:async({slot})=>{calls.push(`slot:${slot.slotKey}`);return 'job'}},worker:{run:async()=>{calls.push('send');return {state:'sent'}}},recovery:{step:async()=>{if(failure)throw new Error('db failed');return {more:false}},due:async()=>states[Math.min(index++,states.length-1)]},prepare:async()=>calls.push('prepare'),monitor:{heartbeat:async(lang,ok)=>{calls.push(`heartbeat:${lang}:${ok}`);if(monitorThrows)throw new Error('monitor failed')}},clock:()=>now,token:()=>token,enabled:()=>enabled})
  return {scheduler,calls}
}
test('scheduler recovers missed previous evening slot at morning checkpoint',async()=>{
  const {scheduler,calls}=fixture();await scheduler.tick();assert.ok(calls.includes('slot:2026-11-25T19:00'));assert.ok(calls.includes('heartbeat:km:true'))
})
test('update stays ahead of recoverable optional slot',async()=>{
  const due=iso('2026-11-26T07:00');const {scheduler,calls}=fixture({states:[{event_due_at:due},{queue_due_at:due,update_ready:true,update_waiting:true},{}]});await scheduler.tick();assert.ok(calls.includes('prepare'));assert.ok(calls.includes('send'));assert.ok(!calls.some(c=>c.startsWith('slot:')))
})
test('cycle failure and bad token record unhealthy heartbeat',async()=>{
  const a=fixture({failure:true});await assert.rejects(a.scheduler.tick());assert.ok(a.calls.includes('heartbeat:km:false'))
  const b=fixture({token:''});await b.scheduler.tick();assert.deepEqual(b.calls,['settings','heartbeat:km:false'])
})
test('monitor failure does not stop delivery; disabled runtime does not query',async()=>{
  const due=iso('2026-11-26T07:00');const a=fixture({monitorThrows:true,states:[{queue_due_at:due,update_waiting:true,update_ready:true},{}]});await a.scheduler.tick();assert.ok(a.calls.includes('send'))
  const b=fixture({enabled:false});await b.scheduler.tick();assert.deepEqual(b.calls,[])
})
