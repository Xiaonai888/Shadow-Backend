import test from 'node:test'
import assert from 'node:assert/strict'
import {normalizeSocialPromotionRule,dueSocialPromotionSlots,createSocialPromotionRules} from '../src/services/socialMedia/socialPromotionRules.service.js'
import {createSocialPromotionQueue} from '../src/services/socialMedia/socialPromotionQueue.service.js'

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const input={connectionId:id(1),name:'Daily',enabled:true,language:'km',publishTimes:['08:00','19:30'],dailyLimit:2}
const revision='2026-11-27T01:00:00.123456+00:00'
const slot='2026-11-27T01:00:00.000Z'
const base={ruleId:id(2),revision,slot,kind:'solo',items:[{storyId:id(3),episodeId:id(4)}]}

test('all five languages are rule settings; no language is tied to account',()=>{
  for(const language of ['km','en','zh','ja','ko']){
    const row=normalizeSocialPromotionRule({...input,language})
    assert.equal(row.language,language)
    assert.equal(row.connection_id,id(1))
    assert.equal(row.content_mode,'short')
    assert.equal(row.owner_id,'shadow')
  }
  assert.throws(()=>normalizeSocialPromotionRule({...input,language:'fr'}),/RULE_INVALID/)
})
test('selection mode validates and normalizes filters',()=>{
  const row=normalizeSocialPromotionRule({...input,selectionMode:'mixed',storyIds:[id(3),id(3)],authorIds:[id(4)],storyTypes:['manga','novel','manga']})
  assert.deepEqual(row.story_ids,[id(3)])
  assert.deepEqual(row.story_types,['manga','novel'])
  assert.throws(()=>normalizeSocialPromotionRule({...input,selectionMode:'authors'}),/SCOPE_INVALID/)
  assert.throws(()=>normalizeSocialPromotionRule({...input,storyIds:[id(3)]}),/SCOPE_INVALID/)
  assert.throws(()=>normalizeSocialPromotionRule({...input,storyTypes:['other']}),/STORY_TYPE_INVALID/)
})
test('admin cannot request full or any manual format',()=>{
  for(const key of ['postFormat','contentMode','content_mode','post_format'])assert.throws(()=>normalizeSocialPromotionRule({...input,[key]:'full'}),/FORMAT_AUTOMATIC/)
  assert.throws(()=>normalizeSocialPromotionRule({...input,publishTimes:[]}),/SCOPE_INVALID/)
  assert.throws(()=>normalizeSocialPromotionRule({...input,publishTimes:['24:00']}),/TIME_INVALID/)
})
test('schedule uses Cambodian local time with a bounded catch-up window',()=>{
  const row=normalizeSocialPromotionRule(input)
  assert.deepEqual(dueSocialPromotionSlots(row,Date.parse('2026-11-27T01:05:00Z')),[slot])
  assert.deepEqual(dueSocialPromotionSlots(row,Date.parse('2026-11-27T01:16:00Z')),[])
  assert.deepEqual(dueSocialPromotionSlots(row,Date.parse('2026-11-27T00:59:00Z')),[])
  assert.deepEqual(dueSocialPromotionSlots({...row,enabled:false},Date.parse(slot)),[])
})
test('late midnight slot is found exactly once across local midnight',()=>{
  const row=normalizeSocialPromotionRule({...input,publishTimes:['23:55','23:55:00']})
  assert.deepEqual(row.publish_times,['23:55:00'])
  assert.deepEqual(dueSocialPromotionSlots(row,Date.parse('2026-11-27T17:05:00Z')),['2026-11-27T16:55:00.000Z'])
})
test('queue preserves exact rule revision and uses one RPC for group',async()=>{
  let calls=0
  const queue=createSocialPromotionQueue({rpc:async(name,args)=>{
    calls++;assert.equal(name,'social_promotion_enqueue_v2');assert.equal(args.p_revision,revision);assert.equal(args.p_kind,'group');assert.equal(args.p_items.length,3);assert.equal(args.p_items[0].story_id,id(3));return {data:{state:'queued',jobId:id(9)}}
  }})
  assert.deepEqual(await queue.enqueue({...base,kind:'group',items:[base.items[0],{storyId:id(5),episodeId:id(6)},{storyId:id(7),episodeId:id(8)}]}),{state:'queued',jobId:id(9)})
  assert.equal(calls,1)
})
test('invalid and duplicate items never reach database',async()=>{
  const queue=createSocialPromotionQueue({rpc:async()=>assert.fail('unexpected RPC')})
  await assert.rejects(queue.enqueue({...base,kind:'group',items:[base.items[0],base.items[0],{storyId:id(5),episodeId:id(6)}]}),/DUPLICATE_ITEMS/)
  await assert.rejects(queue.enqueue({...base,slot:'2026-11-27T01:00:30Z'}),/SLOT_INVALID/)
  await assert.rejects(queue.enqueue({...base,kind:'full'}),/QUEUE_INVALID/)
})
test('queue reports blocked outcomes without retrying',async()=>{
  let calls=0
  const queue=createSocialPromotionQueue({rpc:async()=>{calls++;return {data:{state:'duplicate'}}}})
  assert.deepEqual(await queue.enqueue(base),{state:'duplicate'})
  assert.equal(calls,1)
})
test('history is connection and language scoped and rejects foreign rows',async()=>{
  let calls=0
  const queue=createSocialPromotionQueue({rpc:async(name,args)=>{
    calls++;assert.equal(name,'social_promotion_history_v2');assert.equal(args.p_connection_id,id(1));assert.equal(args.p_language,'ja');assert.deepEqual(args.p_story_ids,[id(3)])
    return {data:{history:[{language:calls===1?'ja':'km',storyId:id(3),status:'sent'}],captionHistory:[]}}
  }})
  assert.equal((await queue.history({connectionId:id(1),language:'ja',storyIds:[id(3),id(3)]})).history.length,1)
  await assert.rejects(queue.history({connectionId:id(1),language:'ja',storyIds:[id(3)]}),/HISTORY_FAILED/)
})
test('rule update scopes owner, account and exact revision',async()=>{
  const eq=[];const db={from(table){assert.equal(table,'social_promotion_rules');return {update(row){assert.equal(row.content_mode,'short');return this},eq(key,val){eq.push([key,val]);return this},select(){return this},async maybeSingle(){return {data:null,error:null}}}}}
  await assert.rejects(createSocialPromotionRules(db).replace(id(2),input,revision),/RULE_STALE/)
  assert.deepEqual(eq,[['id',id(2)],['owner_type','admin'],['owner_id','shadow'],['connection_id',id(1)],['updated_at',revision]])
})
