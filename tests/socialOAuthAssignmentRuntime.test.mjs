import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createSocialPromotionAdmin} from '../src/services/socialMedia/socialPromotionAdmin.service.js'
import {createThreadsTokenRuntime,threadsTokenRuntimeEnabled} from '../src/services/socialMedia/threadsTokenRuntime.service.js'

const id='10000000-0000-4000-8000-000000000001'
const clock=()=>Date.parse('2026-11-28T07:00:00Z')
const connection={id,platform:'threads',status:'connected',token_expires_at:'2027-01-01T00:00:00Z'}
const input={connectionId:id,name:'Promotion',enabled:true,language:'km',publishTimes:['07:00']}
function admin(assignment,assignmentError=null){
  const calls=[]
  const db={from(table){
    calls.push(['from',table]);const result=table==='social_media_bot_assignments'?{data:assignment,error:assignmentError}: {data:connection,error:null}
    const q={select(...args){calls.push(['select',...args]);return q},eq(...args){calls.push(['eq',...args]);return q},maybeSingle(){return Promise.resolve(result)}}
    return q
  }}
  return {calls,service:createSocialPromotionAdmin({db,clock,rules:{create:async()=>{calls.push(['create']);return {id}},replace:async()=>{calls.push(['replace']);return {id}}}})}
}
test('enabled rule requires explicit promotion assignment for Threads',async()=>{
  const a=admin(null);await assert.rejects(a.service.createRule(input),e=>e.code==='SOCIAL_BOT_ASSIGNMENT_REQUIRED'&&e.status===409)
  assert.ok(!a.calls.some(x=>x[0]==='create'))
  const b=admin({connection_id:id});assert.equal((await b.service.createRule(input)).id,id)
  assert.ok(b.calls.some(x=>x.join('|')==='eq|bot_key|promotion'))
  assert.ok(b.calls.some(x=>x.join('|')==='eq|owner_id|shadow'))
})
test('disabled rule remains editable and failed assignment lookup is fail-closed',async()=>{
  const a=admin(null);assert.equal((await a.service.createRule({...input,enabled:false})).id,id)
  assert.ok(!a.calls.some(x=>x[1]==='social_media_bot_assignments'))
  const b=admin(null,{message:'secret'});await assert.rejects(b.service.replaceRule(id,input,'2026-11-28T07:00:00Z'),e=>e.code==='SOCIAL_BOT_DATABASE_FAILED'&&e.status===503)
  assert.ok(!b.calls.some(x=>x[0]==='replace'))
})
const env=()=>({SOCIAL_THREADS_REFRESH_ENABLED:'true',SOCIAL_OAUTH_ADMIN_ENABLED:'true',SOCIAL_MEDIA_TOKEN_KEY:'a'.repeat(64),SOCIAL_THREADS_APP_ID:'123',SOCIAL_THREADS_APP_SECRET:'secret',SOCIAL_THREADS_OAUTH_REDIRECT_URI:'https://admin.example.com/social-oauth/threads'})
function fixture(config=env(),init){
  let calls=0,initializations=0;const timers=[],errors=[]
  const runtime=createThreadsTokenRuntime({env:config,initialize:async()=>{initializations++;return init?init():{run:async()=>{calls++;return {state:'ok'}}}},onError:x=>errors.push(x),setTimer:(fn,delay)=>{const handle={fn,delay,cleared:false};timers.push(handle);return handle},clearTimer:x=>{x.cleared=true}})
  return {runtime,timers,errors,calls:()=>calls,initializations:()=>initializations}
}
test('maintenance defaults off and does not initialize with missing configuration',async()=>{
  for(const config of [{},{...env(),SOCIAL_THREADS_REFRESH_ENABLED:'false'},{...env(),SOCIAL_THREADS_APP_SECRET:''}]){const f=fixture(config);assert.equal(threadsTokenRuntimeEnabled(config),false);assert.equal(f.runtime.start(),false);assert.deepEqual(await f.runtime.tick(),{state:'disabled'});assert.equal(f.initializations(),0);assert.equal(f.timers.length,0)}
})
test('maintenance starts once, waits one minute then schedules hourly, and stops',async()=>{
  const f=fixture();assert.equal(f.runtime.start(),true);assert.equal(f.runtime.start(),false);assert.equal(f.timers[0].delay,60000);await f.timers[0].fn();assert.equal(f.calls(),1);assert.equal(f.timers[1].delay,3600000);await f.timers[1].fn();assert.equal(f.calls(),2);assert.equal(f.initializations(),1);f.runtime.stop();assert.equal(f.timers[2].cleared,true);await f.timers[2].fn();assert.equal(f.calls(),2)
})
test('maintenance does not overlap and sanitizes initialization failure',async()=>{
  let release;const f=fixture(env(),()=>({run:()=>new Promise(r=>{release=r})}));const p=f.runtime.tick();await Promise.resolve();await Promise.resolve();assert.deepEqual(await f.runtime.tick(),{state:'busy'});while(!release)await Promise.resolve();release({state:'ok'});assert.deepEqual(await p,{state:'ok'})
  const b=fixture(env(),()=>{throw new Error('private-secret')});assert.deepEqual(await b.runtime.tick(),{state:'failed'});assert.deepEqual(b.errors,[{code:'SOCIAL_THREADS_REFRESH_RUNTIME_FAILED'}])
})
test('stop during initialization prevents refresh and later timer',async()=>{
  let release,calls=0;const f=fixture(env(),()=>new Promise(r=>{release=r}));f.runtime.start();const p=f.timers[0].fn();await Promise.resolve();f.runtime.stop();release({run:async()=>{calls++;return {state:'ok'}}});await p;assert.equal(calls,0);assert.equal(f.timers.length,1)
})
test('assignment migration retains exclusion, cap and claim guards in SQL source',()=>{
  const sql=readFileSync(new URL('../sql/20261128_social_oauth_assignment_guard_v5.sql',import.meta.url),'utf8')
  assert.equal((sql.match(/b\.bot_key='promotion'/g)||[]).length,5)
  for(const text of ['social_promotion_story_blocked_v6(s.id)','s.is_adult is false','e.is_adult is false','SOCIAL_ACCOUNT_DAILY_LIMIT','j.worker_claim_id=p_claim_id',"c.platform in ('facebook','instagram','threads')",'social_promotion_assignment_ready_v5','for key share nowait'])assert.ok(sql.includes(text),text)
  assert.ok(sql.startsWith('begin;'));assert.ok(sql.trimEnd().endsWith('commit;'))
})
