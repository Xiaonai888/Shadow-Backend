import test from 'node:test'
import assert from 'node:assert/strict'
import { promotionSlotsV2,nextPromotionSlotV2,daytimeBudgetV2,planOptionalSlotV2 } from '../src/services/telegramPromotion/scheduleV2.service.js'
import { createPromotionOptionalV2,selectSoloV2 } from '../src/services/telegramPromotion/optionalV2.service.js'
import { buildStoryPromotionV2 } from '../src/services/telegramPromotion/messageV2.service.js'
const at=t=>Date.parse(`2026-11-27T${t}:00+07:00`)
const date=t=>new Date(t).toISOString()
const stats={existingId:null,updateCount:0,daytimeCount:0,recentTopics:[],similarStory:null}
const slot=t=>promotionSlotsV2(at(t))[0]
const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
function candidate(n,tag='GL'){
  return {story:{id:uid(n),title:`Story ${n}`,story_language:'Khmer',story_type:'novel',story_status:'Completed',status:'published',author_id:uid(100+n),cover_url:`https://media.example.com/${n}.jpg`,main_genre:tag,tags:[tag,'Romance'],total_views:n*10},episode:{id:uid(200+n),story_id:uid(n),title:'Chapter 1',status:'published',first_published_at:date(at('11:00')-86400000),published_at:date(at('11:00')-86400000)},publishedEpisodeCount:6,activity7:n,authorName:'Author'}
}
const setup=({context=stats,rows=[candidate(1),candidate(2),candidate(3)],history=[],captionHistory=[],enqueueResult=uid(900)}={})=>{
  const calls=[]
  const service=createPromotionOptionalV2({db:{async rpc(name,args){calls.push(['rpc',name,args]);return {data:context}}},source:{async candidates(args){calls.push(['candidates',args]);return {candidates:rows,history,captionHistory}}},storySource:{async load(storyId,episodeId){calls.push(['load',storyId,episodeId]);const c=rows.find(c=>c.story.id===storyId);return {story:c.story,episode:{...c.episode,content:'A paragraph. '.repeat(50)}}}},queue:{async enqueueOptional(args){calls.push(['enqueue',args]);return enqueueResult}},messageBuilder:{async build(args){calls.push(['build',args]);return buildStoryPromotionV2(args)}}})
  return {service,calls}
}
test('Cambodia slot boundaries and midnight reset',()=>{
  assert.deepEqual(promotionSlotsV2(at('10:59')),[])
  assert.equal(slot('11:00').slotKey,'2026-11-27T11:00')
  assert.deepEqual(promotionSlotsV2(at('14:00')),[])
  assert.equal(slot('18:00').kind,'smart')
  assert.equal(slot('21:00').kind,'night')
  assert.equal(nextPromotionSlotV2(at('23:59')),Date.parse('2026-11-28T11:00:00+07:00'))
})
test('does not replay slots before activation',()=>assert.deepEqual(promotionSlotsV2(at('11:15'),date(at('11:01'))),[]))
test('daytime budget thresholds',()=>assert.deepEqual([0,5,6,15,16,31].map(daytimeBudgetV2),[2,2,1,1,0,0]))
test('night is independent from daytime budget',()=>assert.deepEqual(planOptionalSlotV2({slot:slot('21:00'),language:'km',stats:{...stats,updateCount:100,daytimeCount:2}}).plans,[{topic:'night',postType:'group',count:3}]))
test('skip second daytime slot when budget used',()=>assert.deepEqual(planOptionalSlotV2({slot:slot('18:00'),language:'km',stats:{...stats,updateCount:6,daytimeCount:1}}).plans,[]))
test('rotate away from recent topics and no similar without tags',()=>{const s=slot('11:00');const p=planOptionalSlotV2({slot:s,language:'km',stats}).plans;const next=planOptionalSlotV2({slot:s,language:'km',stats:{...stats,recentTopics:p.map(x=>({topic:x.topic,at:date(at('11:00')-86400000)}))}}).plans;assert.ok(next.every(x=>!p.some(y=>y.topic===x.topic)&&x.topic!=='similar'))})
test('existing slot does not fetch candidate pool',async()=>{const {service,calls}=setup({context:{...stats,existingId:uid(1)}});assert.equal(await service.enqueue({settings:{enabled:true,language:'km'},slot:slot('21:00'),now:at('21:00')}),uid(1));assert.equal(calls.length,1)})
test('night sends one group with three real links and no episode loading',async()=>{const {service,calls}=setup();assert.equal(await service.enqueue({settings:{enabled:true,language:'km'},slot:slot('21:00'),now:at('21:00')}),uid(900));const job=calls.find(c=>c[0]==='enqueue')[1];assert.equal(job.postType,'group');assert.equal(job.topic,'night');assert.equal(job.message.media.length,3);assert.equal(job.message.media[0].caption_entities.filter(e=>e.type==='text_link').length,3);assert.equal(calls.filter(c=>c[0]==='load').length,0)})
test('night never downgrades to solo if pool insufficient',async()=>{const {service,calls}=setup({rows:[candidate(1),candidate(2)]});assert.equal(await service.enqueue({settings:{enabled:true,language:'km'},slot:slot('21:00'),now:at('21:00')}),null);assert.equal(calls.filter(c=>c[0]==='enqueue').length,0)})
test('solo excludes pending, recently exposed, wrong language and under five EP',()=>{const rows=[1,2,3,4,5].map(n=>candidate(n));rows[3].story.story_language='English';rows[4].publishedEpisodeCount=4;const history=[{language:'km',storyId:uid(1),status:'ready'},{language:'km',storyId:uid(2),status:'sent',sentAt:date(at('11:00')-86400000)}];assert.deepEqual(selectSoloV2({candidates:rows,history,language:'km',topic:'gl',now:at('11:00')}).map(c=>c.story.id),[uid(3)])})
test('daytime group falls back to eligible solo with excerpt',async()=>{const s=slot('11:00');const p=planOptionalSlotV2({slot:s,language:'km',stats}).plans[0];const c=candidate(1,p.topic);const {service,calls}=setup({rows:[c]});assert.equal(await service.enqueue({settings:{enabled:true,language:'km'},slot:s,now:at('11:00')}),uid(900));const job=calls.find(c=>c[0]==='enqueue')[1];assert.equal(job.postType,'solo');assert.ok(job.message.caption.includes('A paragraph'));assert.equal(job.message.reply_markup.inline_keyboard.length,3)})
test('disabled settings do not query database',async()=>{const {service,calls}=setup();assert.equal(await service.enqueue({settings:{enabled:false,language:'km'},slot:slot('21:00'),now:at('21:00')}),null);assert.equal(calls.length,0)})
