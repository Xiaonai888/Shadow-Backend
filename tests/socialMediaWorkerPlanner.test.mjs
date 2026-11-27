import test from 'node:test'
import assert from 'node:assert/strict'
import {createSocialPromotionPlanner} from '../src/services/socialMedia/socialPromotionPlanner.service.js'
import {createSocialPromotionWorker} from '../src/services/socialMedia/socialPromotionWorker.service.js'
import {createSocialPromotionWorkerStore} from '../src/services/socialMedia/socialPromotionWorkerStore.service.js'
const uid=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`
const rule={id:uid(1),owner_type:'admin',owner_id:'shadow',connection_id:uid(2),language:'ja',source_topic:'solo',selection_mode:'smart',story_ids:[],author_ids:[],story_types:[],enabled:true,updated_at:'2026-11-27T00:00:00Z'}
const slot='2026-11-27T00:00:00Z'
const row={story:{id:uid(3),cover_url:'https://cdn.domain.com/a.jpg'},episode:{id:uid(4)}}
const job={id:uid(5),worker_claim_id:uid(6),rule_id:rule.id,connection_id:rule.connection_id,owner_type:'admin',owner_id:'shadow',status:'publishing',content_mode:'short',language:'ja',caption_id:null}
const items=[{story_id:uid(3),episode_id:uid(4)}]
function plan(overrides={}){
  const calls=[]
  const defaults={source:{candidatePage:async args=>{calls.push(['source',args]);return {scanned:1,candidates:[row]}}},selection:{group:()=>({stories:[]}),solo:({candidates})=>candidates},chooseCaption:()=>null,queue:{history:async args=>{calls.push(['history',args]);return {history:[],captionHistory:[]}},enqueue:async args=>{calls.push(['enqueue',args]);return {state:'queued',jobId:job.id}}},updateSource:{candidates:async()=>[row]}}
  return {planner:createSocialPromotionPlanner({...defaults,...overrides}),calls}
}
function worker(platform='facebook',overrides={}){
  const calls=[]
  const context={rule,connection:{id:rule.connection_id,platform,external_id:'123',token_ciphertext:'cipher'}}
  const post={platform,language:'ja',format:'cover',storyIds:[row.story.id],episodeIds:[row.episode.id],captionId:null}
  const deps={store:{claim:async()=>({job,items}),context:async()=>context,finish:async(...args)=>{calls.push(['finish',...args]);return true}},loadPost:async()=>post,decryptToken:()=> 'token',prepareMedia:async({post})=>post,publishFacebook:async()=>{calls.push(['publish']);return {postId:'123_456'}},prepareInstagram:async()=>({state:'container_created',containerId:'12'}),createInstagramCarousel:async()=>({state:'container_created',containerId:'12'}),publishInstagramContainer:async()=>({state:'published',postId:'123'}),wait:async()=>{}}
  return {worker:createSocialPromotionWorker({...deps,...overrides}),calls,deps,context,post}
}
test('planner uses neutral candidate source and per-connection history',async()=>{const {planner,calls}=plan();assert.equal((await planner.plan({rule,slot})).state,'queued');assert.equal(calls[0][1].historyScope,'neutral');assert.equal(calls[0][1].language,'ja');assert.equal(calls[1][1].connectionId,rule.connection_id);assert.equal(calls[2][1].kind,'solo')})
test('disabled or invalid scope never scans',async()=>{const {planner,calls}=plan();assert.equal((await planner.plan({rule:{...rule,enabled:false},slot})).state,'disabled');await assert.rejects(planner.plan({rule:{...rule,selection_mode:'authors'},slot}),/SCOPE/);assert.equal(calls.length,0)})
test('update uses separate read-only source interface',async()=>{const {planner,calls}=plan();await planner.plan({rule:{...rule,source_topic:'update'},slot});assert.equal(calls[0][0],'history');assert.equal(calls[1][1].kind,'update')})
test('worker publishes and finishes once',async()=>{const {worker:w,calls}=worker();assert.equal((await w.run()).state,'published');assert.equal(calls.filter(x=>x[0]==='publish').length,1);assert.deepEqual(calls.at(-1).slice(2),['published',{postId:'123_456',errorCode:null}])})
test('worker cancels if rule or token changes before publish',async()=>{const {deps,calls,context}=worker();let n=0;deps.store.context=async()=>++n===1?context:null;const w=createSocialPromotionWorker(deps);assert.equal((await w.run()).state,'cancelled');assert.equal(calls.filter(x=>x[0]==='publish').length,0)})
test('uncertain response is not retried or leaked',async()=>{let n=0;const {worker:w,calls}=worker('facebook',{publishFacebook:async()=>{n++;throw Object.assign(new Error('PRIVATE_TOKEN'),{uncertain:true,code:'SOCIAL_META_RESPONSE_UNKNOWN'})}});const result=await w.run();assert.equal(result.state,'needs_review');assert.equal(n,1);assert.ok(!JSON.stringify(calls).includes('PRIVATE_TOKEN'))})
test('Instagram polls at most three times, no publish if not ready',async()=>{let n=0;const {worker:w}=worker('instagram',{publishInstagramContainer:async()=>{n++;return {state:'pending'}}});assert.equal((await w.run()).state,'failed');assert.equal(n,3)})
test('Instagram pending then published',async()=>{let n=0;const {worker:w}=worker('instagram',{publishInstagramContainer:async()=>++n===1?{state:'pending'}:{state:'published',postId:'123'}});assert.equal((await w.run()).state,'published');assert.equal(n,2)})
test('worker prevents overlapping runs',async()=>{let release;const {worker:w}=worker('facebook',{publishFacebook:()=>new Promise(r=>release=r)});const first=w.run();assert.equal((await w.run()).state,'busy');while(!release)await new Promise(r=>setImmediate(r));release({postId:'1'});assert.equal((await first).state,'published')})
test('store finalization is fenced by claim ID',async()=>{const calls=[];const store=createSocialPromotionWorkerStore({rpc:async(name,args)=>{calls.push([name,args]);return {data:false}}});await assert.rejects(store.finish(job,'published',{postId:'123'}),/CLAIM_LOST/);assert.equal(calls[0][1].p_claim_id,job.worker_claim_id)})
