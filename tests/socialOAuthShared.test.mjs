import test from 'node:test'
import assert from 'node:assert/strict'
import {createSocialBotAssignments} from '../src/services/socialMedia/socialBotAssignments.service.js'
import {createThreadsOAuthAdmin} from '../src/services/socialMedia/threadsOAuthAdmin.service.js'
import {createThreadsTokenMaintenance} from '../src/services/socialMedia/threadsTokenMaintenance.service.js'
import {SocialOAuthError} from '../src/services/socialMedia/socialOAuthState.service.js'
const id='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002',state='a'.repeat(43)
const now=Date.parse('2026-11-28T07:00:00Z'),clock=()=>now
const iso=ms=>new Date(ms).toISOString()
const account={platform:'threads',externalId:'123',displayName:'Shadow',token:'private-token',expiresAt:iso(now+86400000*60)}
const session='20000000-0000-4000-8000-000000000001',device='30000000-0000-4000-8000-000000000001'
const req=(body={},token='admin-bearer',sessionId=session,deviceId=device)=>({admin:{admin_id:'admin-1',has_all_permissions:true,session:{id:sessionId},device:{id:deviceId}},headers:{authorization:`Bearer ${token}`},body})
function adminFixture(overrides={}){
  let binding;const calls=[]
  const deps={stateStore:{issue:async c=>{binding=JSON.stringify(c);calls.push('issue');return state},consume:async(c,s)=>{if(binding!==JSON.stringify(c)||s!==state)throw new SocialOAuthError('SOCIAL_OAUTH_STATE_INVALID');binding=null;calls.push('consume')}},threads:{authorizationUrl:s=>'https://threads.net/oauth/authorize?state='+s,complete:async()=>{calls.push('exchange');return account}},accountStore:{importAdmin:async a=>{assert.deepEqual(a,[account]);calls.push('import');return {saved:1,skipped:0}}},reconnect:{target:async i=>{assert.equal(i,id);calls.push('target');return {platform:'threads'}},reconnect:async(i,a)=>{assert.equal(i,id);assert.deepEqual(a,[account]);calls.push('reconnect');return {saved:1,skipped:0,disabledRules:1,cancelledJobs:2}}},...overrides}
  return {calls,service:createThreadsOAuthAdmin(deps)}
}
test('assignment list uses one bounded RPC and projects no secret fields',async()=>{
  const calls=[];const service=createSocialBotAssignments({rpc:async(n,a)=>{calls.push([n,a]);return {data:[{connectionId:id,bot:'promotion',token:'secret'}]}}})
  assert.deepEqual(await service.list([]),[]);assert.deepEqual(await service.list([id,id,other]),[{connectionId:id,bot:'promotion'}]);assert.deepEqual(calls,[['social_oauth_bot_list_v4',{p_ids:[id,other]}]])
})
test('invalid assignments and oversized page rejected before RPC',async()=>{
  const service=createSocialBotAssignments({rpc:async()=>{throw new Error('unexpected call')}})
  await assert.rejects(service.list(Array(11).fill(id)),/LIST_INVALID/);await assert.rejects(service.set(id,'unknown',true),/ASSIGNMENT_INVALID/);await assert.rejects(service.set(id,'event','true'),/ASSIGNMENT_INVALID/)
})
test('remove promotion assignment reports disabled rules and cancelled jobs',async()=>{
  const service=createSocialBotAssignments({rpc:async(n,a)=>{assert.equal(n,'social_oauth_assign_bot_v4');assert.deepEqual(a,{p_id:id,p_bot:'promotion',p_assigned:false});return {data:{state:'unassigned',changed:true,disabledRules:2,cancelledJobs:3}}}})
  assert.deepEqual(await service.set(id,'promotion',false),{state:'unassigned',changed:true,disabledRules:2,cancelledJobs:3})
})
test('assignment list rejects foreign IDs and duplicate rows',async()=>{
  for(const data of [[{connectionId:other,bot:'event'}],[{connectionId:id,bot:'event'},{connectionId:id,bot:'event'}]])await assert.rejects(createSocialBotAssignments({rpc:async()=>({data})}).list([id]),/RESPONSE_INVALID/)
})
test('Threads callback consumes bound state before import and returns no token',async()=>{
  const {service,calls}=adminFixture();await service.start(req());const result=await service.complete(req({state,code:'auth-code'}));assert.deepEqual(calls,['issue','consume','exchange','import']);assert.deepEqual(result,{mode:'sync',threadsFound:1,saved:1,skipped:0});assert.ok(!JSON.stringify(result).includes(account.token));await assert.rejects(service.complete(req({state,code:'auth-code'})),/STATE_INVALID/)
})
test('Threads reconnect binds account and admin session, not arbitrary callback',async()=>{
  const {service,calls}=adminFixture();await service.start(req({connectionId:id}));await assert.rejects(service.complete(req({state,code:'code',connectionId:id},'wrong-session',other)),/STATE_INVALID/);await assert.rejects(service.complete(req({state,code:'code'})),/STATE_INVALID/);await assert.rejects(service.complete(req({state,code:'code',connectionId:id},'wrong-device',session,other)),/STATE_INVALID/);const result=await service.complete(req({state,code:'code',connectionId:id},'renewed-token'));assert.equal(result.mode,'reconnect');assert.equal(result.disabledRules,1);assert.equal(result.cancelledJobs,2);assert.deepEqual(calls,['target','issue','consume','target','exchange','reconnect'])
})
test('Threads non-full-admin and Facebook reconnect are rejected',async()=>{
  const {service}=adminFixture({reconnect:{target:async()=>({platform:'facebook'}),reconnect:async()=>{throw new Error('unexpected')}}});await assert.rejects(service.start({...req(),admin:{has_all_permissions:false}}),/PERMISSION_REQUIRED/);await assert.rejects(service.start(req({connectionId:id})),/CONNECTION_NOT_FOUND/)
})
const row={id,external_id:'123',token_ciphertext:'v1.abc.def.ghi',updated_at:iso(now-86400000*55),oauth_refresh_after:iso(now+21600000),token_expires_at:iso(now+86400000*5)}
function refreshFixture(overrides={}){
  const calls=[];const deps={clock,db:{rpc:async(n,a)=>{calls.push([n,a]);return {data:n.includes('claim')?[row]:true}}},threads:{refreshUserToken:async t=>{assert.equal(t,'old-private');return {token:'new-private',expiresIn:86400000/1000*60}},verifyAccount:async(t,i)=>{assert.equal(t,'new-private');assert.equal(i,'123');return {externalId:i}}},decryptToken:(c,b)=>{assert.equal(c,row.token_ciphertext);assert.deepEqual(b,{ownerType:'admin',ownerId:'shadow',platform:'threads',externalId:'123'});return 'old-private'},encryptToken:(t,b)=>{assert.equal(t,'new-private');assert.equal(b.platform,'threads');return 'v1.new.tag.cipher'},...overrides}
  return {calls,service:createThreadsTokenMaintenance(deps)}
}
test('refresh claims max five and finishes with revision and lease compare-and-set',async()=>{
  const {service,calls}=refreshFixture();assert.deepEqual(await service.run(),{state:'ok',claimed:1,refreshed:1,reauth:0,stale:0,failed:0});assert.deepEqual(calls[1],['social_threads_refresh_finish_v4',{p_id:id,p_revision:row.updated_at,p_lease:row.oauth_refresh_after,p_cipher:'v1.new.tag.cipher',p_expires:iso(now+86400000*60),p_reauth:false}]);assert.ok(!JSON.stringify(calls).includes('new-private'))
})
test('refresh cannot overwrite newer connection when CAS fails',async()=>{
  const {service}=refreshFixture({db:{rpc:async n=>({data:n.includes('claim')?[row]:false})}});const r=await service.run();assert.equal(r.stale,1);assert.equal(r.refreshed,0)
})
test('only explicit invalid token marks reauth; transient errors leave lease for backoff',async()=>{
  for(const code of ['SOCIAL_THREADS_REAUTH_REQUIRED','SOCIAL_THREADS_NETWORK_FAILED']){const {service,calls}=refreshFixture({threads:{refreshUserToken:async()=>{throw new SocialOAuthError(code,401)},verifyAccount:async()=>({})}});const r=await service.run();if(code.includes('REAUTH')){assert.equal(r.reauth,1);assert.equal(calls[1][1].p_reauth,true);assert.equal(calls[1][1].p_cipher,null)}else{assert.equal(r.failed,1);assert.equal(calls.length,1)}}
})
test('wrong refreshed account or expired lease never writes credentials',async()=>{
  const {service,calls}=refreshFixture({threads:{refreshUserToken:async()=>({token:'new-private',expiresIn:3600}),verifyAccount:async()=>({externalId:'999'})}});assert.equal((await service.run()).failed,1);assert.equal(calls.length,1)
  let count=0;const expired=refreshFixture({db:{rpc:async()=>{count++;return {data:[{...row,oauth_refresh_after:iso(now-1000)}]}}}});assert.equal((await expired.service.run()).failed,1);assert.equal(count,1)
})
test('maintenance never overlaps local runs',async()=>{
  let release;const {service}=refreshFixture({db:{rpc:()=>new Promise(r=>{release=r})}});const pending=service.run();assert.deepEqual(await service.run(),{state:'busy'});release({data:[]});assert.equal((await pending).claimed,0)
})

test('Threads requires a verified session and device',async()=>{const {service,calls}=adminFixture();for(const key of ['session','device']){const r=req();delete r.admin[key];await assert.rejects(service.start(r),/IDENTITY_INVALID/)}assert.equal(calls.length,0)})
