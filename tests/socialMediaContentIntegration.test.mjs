import test from 'node:test'
import assert from 'node:assert/strict'
import {createSocialPromotionContentSource} from '../src/services/socialMedia/socialPromotionContentSource.service.js'
import {createSocialPromotionPostLoader} from '../src/services/socialMedia/socialPromotionPostLoader.service.js'

const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`
const stamp='2026-11-27T04:00:00.000Z', now=Date.parse(stamp)+60000
const rule={id:id(1),owner_type:'admin',owner_id:'shadow',language:'km',source_topic:'update',updated_at:stamp}
const job={rule_id:rule.id,rule_revision:stamp,language:'km',post_kind:'update',source_topic:'update',scheduled_at:stamp,caption_id:null}
const items=[{position:1,story_id:id(2),episode_id:id(3)}]
const candidate=({free=false,type='novel',published=stamp}={})=>({story:{id:id(2),story_type:type},episode:{id:id(3),story_id:id(2),first_published_at:published,is_free_published:free,is_locked:!free,content:free?'hello':null},publishedEpisodeCount:5})
const rpc=(fn)=>({rpc:async(name,args)=>({data:fn(name,args),error:null})})
function loader(row,overrides={}){
  return createSocialPromotionPostLoader({freshSource:{fresh:async()=>row},sharedSource:{mangaPages:async()=>[]},postContent:{build:opts=>opts},adaptPost:({platform,content})=>({platform,...content}),statusSource:{status:async()=>({firstEpisode:false})},clock:()=>now,...overrides})
}

test('update source uses revision and exact bounded limit',async()=>{
  const src=createSocialPromotionContentSource(rpc((name,args)=>{
    assert.equal(name,'social_promotion_updates_v4');assert.equal(args.p_revision,stamp);assert.equal(args.p_limit,30)
    return [{story:{id:id(2)},episode:{id:id(3)}}]
  }))
  assert.equal((await src.candidates({rule,slot:stamp})).length,1)
  await assert.rejects(src.candidates({rule,slot:stamp,limit:31}),/INVALID/)
})
test('update source rejects duplicate episode IDs',async()=>{
  const row={story:{id:id(2)},episode:{id:id(3)}}
  const src=createSocialPromotionContentSource(rpc(()=>[row,row]))
  await assert.rejects(src.candidates({rule,slot:stamp}),/RESPONSE/)
})
test('fresh source refuses content returned for a locked episode',async()=>{
  const row=candidate();row.episode.content='private'
  const src=createSocialPromotionContentSource(rpc(()=>row))
  await assert.rejects(src.fresh({storyId:id(2),episodeId:id(3),topic:'update',preview:true}),/ISOLATION/)
})
test('fresh group request refuses free content',async()=>{
  const src=createSocialPromotionContentSource(rpc(()=>candidate({free:true})))
  await assert.rejects(src.fresh({storyId:id(2),episodeId:id(3),topic:'completed'}),/ISOLATION/)
})
test('fresh source verifies IDs and returns free data only on requested preview',async()=>{
  const src=createSocialPromotionContentSource(rpc((name,args)=>{assert.equal(args.p_preview,true);return candidate({free:true})}))
  assert.equal((await src.fresh({storyId:id(2),episodeId:id(3),topic:'update',preview:true})).episode.content,'hello')
  await assert.rejects(src.fresh({storyId:id(4),episodeId:id(3),topic:'update',preview:true}),/RESPONSE/)
})
test('update loader rejects previous Cambodian day and stale revision',async()=>{
  const args={job,items,rule,platform:'facebook'}
  assert.equal(await loader(candidate({published:'2026-11-26T16:59:00Z'}))(args),null)
  assert.equal(await loader(candidate())({...args,rule:{...rule,updated_at:'2026-11-27T03:00:00Z'}}),null)
})
test('locked manga never loads pages',async()=>{
  const row=candidate({type:'manga'})
  const post=await loader(row,{sharedSource:{mangaPages:async()=>assert.fail('locked manga')}})({job,items,rule,platform:'instagram'})
  assert.equal(post.mangaPages,undefined)
})
test('free manga loads pages and status',async()=>{
  const row=candidate({type:'manga',free:true})
  const post=await loader(row,{sharedSource:{mangaPages:async ep=>{assert.equal(ep,id(3));return ['page']}}})({job,items,rule,platform:'instagram'})
  assert.deepEqual(post.mangaPages,['page']);assert.deepEqual(post.statusContext,{firstEpisode:false})
})
test('group restores reserved caption without exposing episode content',async()=>{
  const groupItems=[0,1,2].map(i=>({position:i+1,story_id:id(10+i),episode_id:id(20+i)}))
  const groupRule={...rule,source_topic:'completed'}
  const groupJob={...job,post_kind:'group',source_topic:'completed',caption_id:'reserved'}
  const post=await loader(null,{freshSource:{fresh:async({storyId,episodeId,preview})=>{assert.equal(preview,false);return {story:{id:storyId},episode:{id:episodeId}}}},postContent:{build:opts=>({captionId:opts.captionHistory.length?'reserved':'other'})}})({job:groupJob,items:groupItems,rule:groupRule,platform:'facebook'})
  assert.equal(post.captionId,'reserved')
})
test('group stops if reserved caption no longer available',async()=>{
  const groupItems=[0,1,2].map(i=>({position:i+1,story_id:id(10+i),episode_id:id(20+i)}))
  const groupRule={...rule,source_topic:'completed'}
  const groupJob={...job,post_kind:'group',source_topic:'completed',caption_id:'reserved'}
  const post=await loader(null,{freshSource:{fresh:async({storyId,episodeId})=>({story:{id:storyId},episode:{id:episodeId}})},postContent:{build:()=>({captionId:'other'})}})({job:groupJob,items:groupItems,rule:groupRule,platform:'facebook'})
  assert.equal(post,null)
})
