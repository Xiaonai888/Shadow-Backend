import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowAiEligibility } from '../services/shadowAi/shadowAiPreOrderEligibility.service.js'

const reader='10000000-0000-4000-8000-000000000001', chat='10000000-0000-4000-8000-000000000002', author='10000000-0000-4000-8000-000000000003', campaign='10000000-0000-4000-8000-000000000004'
const now=Date.parse('2026-11-27T00:00:00Z')
const scope={actorUserId:reader,conversationId:chat}
const valid={id:campaign,title:'Book',close_at:'2026-12-01T00:00:00Z',can_book:true}
function fixture({env={SHADOW_AI_ENABLED:'true',SHADOW_AI_MODEL:'test-model',OPENAI_API_KEY:'test-key'},settings={enabled:true,preorder_enabled:true},delivery=[{company_key:'jnt',is_active:true}],payload={campaigns:[valid],has_more:false,next_offset:null},deny=false,rpcError=false}={}) {
  const calls=[]
  const chain={select(){return this},eq(){return this},maybeSingle(){return this},async abortSignal(){return {data:settings,error:null}}}
  const db={from(name){calls.push(name);return chain},rpc(name,args){calls.push([name,args]);return {async abortSignal(){return {data:payload,error:rpcError?{}:null}}}}}
  const resolve=async input=>{calls.push('resolve');assert.deepEqual(input,scope);if(deny) throw Object.assign(new Error('denied'),{code:'SHADOW_AI_SESSION_DENIED'});return author}
  const getDeliverySettings=async id=>{calls.push('delivery');assert.equal(id,author);return delivery}
  return {calls,run:createShadowAiEligibility({db,resolve,getDeliverySettings,env,now:()=>now})}
}
test('runtime disabled uses no database or AI',async()=>{const f=fixture({env:{}});assert.equal((await f.run(scope)).enabled,false);assert.deepEqual(f.calls,[])})
test('database disabled does not query chat or stock',async()=>{const f=fixture({settings:{enabled:false,preorder_enabled:false}});assert.equal((await f.run(scope)).enabled,false);assert.deepEqual(f.calls,['shadow_ai_settings'])})
test('verified eligible campaign is scoped to authenticated author',async()=>{const f=fixture();const result=await f.run(scope);assert.equal(result.stock_verified,true);assert.deepEqual(result.campaigns,[valid]);assert.deepEqual(f.calls[3],['shadow_ai_eligible_campaigns_v1',{p_author_page_id:author,p_active_delivery_keys:['jnt'],p_offset:0}])})
test('unauthorized chat stops before delivery and stock',async()=>{const f=fixture({deny:true});await assert.rejects(f.run(scope),{code:'SHADOW_AI_SESSION_DENIED'});assert.deepEqual(f.calls,['shadow_ai_settings','resolve'])})
test('no active carrier returns no campaigns',async()=>{const f=fixture({delivery:[{company_key:'jnt',is_active:false}]});assert.deepEqual((await f.run(scope)).campaigns,[]);assert.equal(f.calls.length,3)})
test('expired campaign is hidden',async()=>{const f=fixture({payload:{campaigns:[{...valid,close_at:'2026-11-26T00:00:00Z'}],has_more:false,next_offset:null}});assert.deepEqual((await f.run(scope)).campaigns,[])})
test('unverified response fails closed',async()=>{const f=fixture({payload:{campaigns:[{...valid,can_book:false}],has_more:false,next_offset:null}});await assert.rejects(f.run(scope),{code:'SHADOW_AI_ELIGIBILITY_UNAVAILABLE'})})
test('RPC errors do not claim stock verified',async()=>{const f=fixture({rpcError:true});await assert.rejects(f.run(scope),{code:'SHADOW_AI_ELIGIBILITY_UNAVAILABLE'})})
test('pagination is bounded',async()=>{const f=fixture({payload:{campaigns:[],has_more:true,next_offset:20}});assert.equal((await f.run({...scope,offset:10})).next_offset,20);await assert.rejects(f.run({...scope,offset:1001}),{code:'SHADOW_AI_INVALID_REQUEST'})})
