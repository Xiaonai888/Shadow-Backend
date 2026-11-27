import test from 'node:test'
import assert from 'node:assert/strict'
import {createPromotionCompletionV2} from '../src/services/telegramPromotion/completionV2.service.js'
import {createPromotionScheduler} from '../src/services/telegramPromotion/scheduler.service.js'
const now=Date.parse('2026-11-27T16:00:00+07:00')
const story={id:'11111111-1111-4111-8111-111111111111',title:'Test Story',story_language:'Khmer',story_type:'novel',story_status:'Completed',status:'published',cover_url:'https://example.com/cover.jpg'}
const episode={id:'22222222-2222-4222-8222-222222222222',story_id:story.id,title:'Episode 1',status:'published',content:'private body '.repeat(200)}
const row={story_id:story.id,episode_id:episode.id,completed_at:new Date(now-3600000).toISOString()}
const settings={enabled:true,language:'km',channel_id:'-100123'}
function fixture({s=story,e=episode,rows=[row]}={}){
  const calls=[]
  const db={rpc:async(name,args)=>{calls.push({name,args});return {data:name.endsWith('_due')?rows:'job'}}}
  const source={load:async()=>({story:s,episode:e}),authorName:async()=>''}
  return {calls,service:createPromotionCompletionV2({db,source})}
}
test('completion sends a public cover and links with no episode excerpt',async()=>{const {calls,service}=fixture();assert.deepEqual(await service.run(settings),{queued:1});const p=calls[1].args;assert.equal(p.p_completed_at,row.completed_at);assert.ok(p.p_payload.caption.startsWith('✅ Just Completed'));assert.ok(!p.p_payload.caption.includes('private body'));assert.equal(p.p_payload.caption_entities.filter(e=>e.type==='text_link').length,4)})
test('reopened story skips',async()=>{const {service,calls}=fixture({s:{...story,story_status:'Ongoing'}});assert.equal((await service.run(settings)).queued,0);assert.equal(calls.length,1)})
test('restricted story or episode skips',async()=>{for(const opts of [{s:{...story,is_adult:true}},{e:{...episode,is_adult:true}}]){const {calls,service}=fixture(opts);assert.equal((await service.run(settings)).queued,0);assert.equal(calls.length,1)}})
test('disabled channel does not query',async()=>{const {service,calls}=fixture();assert.equal((await service.run({...settings,enabled:false})).queued,0);assert.equal(calls.length,0)})
test('completion fetch is bounded',async()=>{const {service}=fixture({rows:[row,row,row,row]});await assert.rejects(service.run(settings),/Invalid completion response/)})
test('scheduler checks completion only without update backlog and throttles repeat',async()=>{let t=now,blocked=true,count=0;const v2={supports:()=>true,completion:{run:async()=>{count++;return {queued:0}}},slots:()=>[],nextSlot:()=>Infinity,updateQueue:{nextEditDue:async()=>null},editWorker:{run:async()=>({state:'idle'})},worker:{run:async()=>{}},prepare:async()=>{},optional:{enqueue:async()=>null}};const scheduler=createPromotionScheduler({queue:{settings:async()=>[settings]},source:{},candidates:{},worker:{},recovery:{step:async()=>({more:false}),due:async()=>({update_waiting:blocked})},clock:()=>t,enabled:()=>true,token:()=>'123:abc',v2});await scheduler.tick();assert.equal(count,0);blocked=false;await scheduler.tick();await scheduler.tick();assert.equal(count,1);t+=600000;await scheduler.tick();assert.equal(count,2)})
