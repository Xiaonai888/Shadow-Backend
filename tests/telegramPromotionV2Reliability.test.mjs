import test from 'node:test'
import assert from 'node:assert/strict'
import { createPromotionReliabilityV2 } from '../src/services/telegramPromotion/reliabilityV2.service.js'

const due=Date.parse('2026-11-28T14:00:00Z')
const settings={language:'km',enabled:true,enabled_at:'2026-11-27T00:00:00Z'}
const claim={language:'km',slotKey:'2026-11-28T21:00',claimId:'00000000-0000-4000-8000-000000000001',attempt:1,stage:'main',dueAt:new Date(due).toISOString(),expiresAt:new Date(due+10800000).toISOString()}
const pulse=(c=claim)=>({claim:c,nextAt:new Date(due+120000).toISOString(),disabled:false})
function fixture({execute=async()=>null,initial=pulse(),finish=true}={}){
  let now=due;const calls=[],errors=[];let current=initial
  const db={async rpc(name,args){calls.push({name,args});return {data:name.endsWith('_pulse')?current:finish,error:null}}}
  const service=createPromotionReliabilityV2({db,execute,clock:()=>now,onError:e=>errors.push(e)})
  return {service,calls,errors,advance:ms=>{now+=ms},setPulse:v=>{current=v}}
}
test('claim exists before preparation and queue success is not delivery success',async()=>{
  let f;f=fixture({execute:async({slot,stage})=>{assert.equal(f.calls.length,1);assert.equal(slot.kind,'night');assert.equal(stage,'main');return '00000000-0000-4000-8000-000000000002'}})
  assert.equal((await f.service.run(settings)).state,'queued')
  assert.equal(f.calls[1].args.p_outcome,'queued')
})
test('preparation timeout preserves retry and redacts credentials',async()=>{
  const f=fixture({execute:async()=>{throw new Error('statement timeout 123:secret_token')}})
  assert.equal((await f.service.run(settings)).state,'retry')
  assert.match(f.calls[1].args.p_reason,/statement timeout \[redacted\]/)
  assert.equal(f.errors[0].code,'TELEGRAM_PROMOTION_SLOT_PREPARE_FAILED')
})
test('idle cache prevents database scans until the next due time',async()=>{
  const f=fixture({initial:pulse(null)})
  await f.service.run(settings);await f.service.run(settings)
  assert.equal(f.calls.length,1)
  f.advance(120000);await f.service.run(settings);assert.equal(f.calls.length,2)
})
test('restart-compatible fallback claim is passed to the executor',async()=>{
  const f=fixture({initial:pulse({...claim,attempt:3,stage:'fallback'}),execute:async({stage,attempt})=>{assert.equal(stage,'fallback');assert.equal(attempt,3);return {state:'retry',reason:'POOL_INSUFFICIENT'}}})
  f.advance(600000)
  assert.equal((await f.service.run(settings)).state,'retry')
  assert.equal(f.calls[1].args.p_reason,'POOL_INSUFFICIENT')
})
test('concurrent runs share the same claim',async()=>{
  let runs=0;const f=fixture({execute:async()=>{runs++;return null}})
  await Promise.all([f.service.run(settings),f.service.run(settings)])
  assert.equal(runs,1);assert.equal(f.calls.length,2)
})
test('expired slot is not executed',async()=>{
  const f=fixture({execute:async()=>{throw new Error('must not run')}})
  f.advance(10800000)
  assert.equal((await f.service.run(settings)).state,'retry')
  assert.equal(f.calls[1].args.p_reason,'SLOT_EXPIRED_DURING_CLAIM');assert.equal(f.errors.length,0)
})
test('stale claim never reports successful preparation',async()=>{
  const f=fixture({finish:false})
  assert.equal((await f.service.run(settings)).state,'claim_lost')
  assert.equal(f.errors[0].code,'TELEGRAM_PROMOTION_SLOT_CLAIM_LOST')
})
test('database error uses bounded retry without executing',async()=>{
  let runs=0;const service=createPromotionReliabilityV2({db:{rpc:async()=>({error:{message:'timeout'}})},execute:async()=>{runs++},clock:()=>due})
  assert.deepEqual(await service.run(settings),{state:'error',nextAt:due+60000});assert.equal(runs,0)
})
