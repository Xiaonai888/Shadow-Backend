import test from 'node:test'
import assert from 'node:assert/strict'
import {latestRecoveryCheckpoint,nextRecoveryCheckpoint,recoveryCheckpointDue,optionalRecoveryExpiry,recoverablePromotionSlots} from '../src/services/telegramPromotion/recoveryClock.service.js'
import {createPromotionMonitor} from '../src/services/telegramPromotion/monitoring.service.js'
const kh=t=>Date.parse(`${t}+07:00`)
const date='2026-11-26'
const iso=t=>new Date(kh(t)).toISOString()
test('fixed checkpoints before, at and after midnight',()=>{
  for(const [time,latest,next] of [['06:59','2026-11-25T18:00',`${date}T07:00`],['07:00',`${date}T07:00`,`${date}T11:00`],['11:00',`${date}T11:00`,`${date}T18:00`],['18:00',`${date}T18:00`,'2026-11-27T07:00'],['23:59',`${date}T18:00`,'2026-11-27T07:00']]){
    assert.equal(latestRecoveryCheckpoint(kh(`${date}T${time}`)),kh(latest));assert.equal(nextRecoveryCheckpoint(kh(`${date}T${time}`)),kh(next))
  }
})
test('recovery is immediate on first activation and after missed checkpoint',()=>{
  const enabled=iso(`${date}T08:00`)
  assert.equal(recoveryCheckpointDue(null,enabled,kh(`${date}T08:00`)),true)
  assert.equal(recoveryCheckpointDue(iso(`${date}T08:00`),enabled,kh(`${date}T10:59`)),false)
  assert.equal(recoveryCheckpointDue(iso(`${date}T08:00`),enabled,kh(`${date}T11:00`)),true)
  assert.equal(recoveryCheckpointDue(null,null,kh(`${date}T11:00`)),false)
  assert.equal(recoveryCheckpointDue(null,iso(`${date}T18:00`),kh(`${date}T11:00`)),false)
})
test('optional slots survive until next checkpoint plus three hours',()=>{
  assert.equal(optionalRecoveryExpiry(kh(`${date}T12:00`)),kh(`${date}T21:00`))
  assert.equal(optionalRecoveryExpiry(kh(`${date}T19:00`)),kh('2026-11-27T10:00'))
})
test('recover optional slots across midnight without duplicating or reviving expired slots',()=>{
  const slot={day:4,time:'19:00',kind:'completed'}
  const schedule=[slot,slot,{day:4,time:'12:00',kind:'completed'},{day:5,time:'12:00',kind:'short'}]
  assert.deepEqual(recoverablePromotionSlots(schedule,kh('2026-11-27T07:00')).map(s=>s.slotKey),[`${date}T19:00`])
  assert.deepEqual(recoverablePromotionSlots(schedule,kh('2026-11-27T10:00')),[])
  assert.deepEqual(recoverablePromotionSlots(schedule,kh('2026-11-27T07:00'),iso(`${date}T20:00`)),[])
})
test('heartbeat throttles normal cycles but records changes immediately',async()=>{
  let now=0;const calls=[];const db={rpc:async(name,args)=>{calls.push({name,args});return {data:true}}}
  const m=createPromotionMonitor(db,{clock:()=>now,instanceId:'test'})
  assert.equal(await m.heartbeat('km',true),true)
  now=60000;assert.equal(await m.heartbeat('km',true),false)
  assert.equal(await m.heartbeat('km',false,'123456:secret_token'),true)
  assert.equal(calls.at(-1).args.p_error,'[redacted]')
  assert.equal(await m.heartbeat('km',true),true)
  now+=600000;assert.equal(await m.heartbeat('km',true),true)
  assert.equal(calls.length,4)
})
test('failed heartbeat does not break worker and does not mark write as successful',async()=>{
  let n=0;const errors=[];const db={rpc:async()=>++n===1?{error:{message:'123456:secret_token'}}:{data:true}}
  const m=createPromotionMonitor(db,{clock:()=>0,onError:e=>errors.push(e)})
  assert.equal(await m.heartbeat('km',true),false)
  assert.equal(await m.heartbeat('km',true),true)
  assert.equal(errors[0].message,'[redacted]')
})
test('heartbeat has one in-flight write per language',async()=>{
  let release;const db={rpc:()=>new Promise(resolve=>{release=resolve})}
  const m=createPromotionMonitor(db)
  const a=m.heartbeat('km',true)
  assert.equal(await m.heartbeat('km',true),false)
  release({data:true});assert.equal(await a,true)
})
test('monitor status returns database report without issuing Telegram requests',async()=>{
  const db={rpc:async(name)=>{assert.equal(name,'telegram_promotion_monitor_status_v1');return {data:[{language:'km',worker_state:'healthy'}]}}}
  assert.deepEqual(await createPromotionMonitor(db).report(),[{language:'km',worker_state:'healthy'}])
})
