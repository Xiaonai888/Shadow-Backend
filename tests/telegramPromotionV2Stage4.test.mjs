import test from 'node:test'
import assert from 'node:assert/strict'
import { createPromotionSourceV2 } from '../src/services/telegramPromotion/sourceV2.service.js'
const now=Date.parse('2026-11-27T14:00:00+07:00'),date=new Date(now-86400000).toISOString()
const make=(id,language='Khmer')=>({story:{id,title:`Story ${id}`,author_id:`author${id}`,cover_url:'https://example.com/a.jpg',story_language:language,status:'published',story_status:'Completed',story_type:'novel',tags:['GL'],total_views:100},episode:{id:`ep${id}`,story_id:id,status:'published',first_published_at:date,published_at:date},publishedEpisodeCount:5,activity7:4})
const page=(candidates=[],scanned=0,history=[],captions=[])=>({scanned,candidates,history,captions})
test('filters language and episode count and returns actual group',async()=>{
 const bad=make('bad');bad.publishedEpisodeCount=4
 const db={rpc:async()=>({data:page([make('a'),make('b'),make('c'),make('en','English'),bad],5)})}
 const r=await createPromotionSourceV2(db).candidates({language:'km',topic:'gl',count:3,now})
 assert.equal(r.candidates.length,3);assert.equal(r.selection.stories.length,3);assert.equal(r.pages,1)
})
test('continues after an empty eligible page and stops once enough',async()=>{
 let calls=[];const db={rpc:async(n,p)=>{calls.push(p.p_offset);return {data:calls.length===1?page([],100):page([make('a'),make('b'),make('c')],100)}}}
 const r=await createPromotionSourceV2(db).candidates({language:'km',topic:'gl',count:3,now});assert.deepEqual(calls,[0,100]);assert.equal(r.selection.stories.length,3)
})
test('shared history excludes recent stories and reserves pending captions',async()=>{
 const db={rpc:async()=>({data:page([make('a'),make('b'),make('c'),make('d')],4,[{language:'km',story_id:'a',status:'sent',sent_at:date}],[{language:'km',caption_id:'km:gl:0',status:'ready',updated_at:'2020-01-01'}])})}
 const r=await createPromotionSourceV2(db).candidates({language:'km',topic:'gl',count:3,now});assert.ok(!r.selection.stories.some(c=>c.story.id==='a'));assert.equal(r.captionHistory[0].sentAt,new Date(now).toISOString())
})
test('caps page scans',async()=>{
 let calls=0;const db={rpc:async()=>{calls++;return {data:page([],100)}}};const r=await createPromotionSourceV2(db).candidates({language:'km',topic:'night',now,maxPages:2});assert.equal(calls,2);assert.equal(r.exhausted,false);assert.equal(r.selection.stories.length,0)
})
test('reads manga metadata in a single RPC and obeys 30 percent',async()=>{
 let calls=0;const rows=Array.from({length:10},(_,i)=>({sort_order:i,image_url:`https://example.com/${i}.jpg`,width:800,height:1200,parts:[]}));const db={rpc:async(n)=>{calls++;assert.equal(n,'telegram_promotion_v2_manga_pages');return {data:rows}}};const r=await createPromotionSourceV2(db).mangaPreview('00000000-0000-0000-0000-000000000001');assert.equal(calls,1);assert.equal(r.photos.length,3);assert.ok(r.coveragePercent<=30)
})
test('rejects invalid arguments and malformed database response',async()=>{
 const s=createPromotionSourceV2({rpc:async()=>({data:{}})});await assert.rejects(()=>s.candidates({language:'zh',topic:'gl',now}));await assert.rejects(()=>s.candidates({language:'km',topic:'gl',now}));await assert.rejects(()=>s.mangaPreview('invalid'))
})
test('does not expose token in database error',async()=>{
 const s=createPromotionSourceV2({rpc:async()=>({error:{message:'bad 123456789:abcdefghijk'}})});await assert.rejects(()=>s.candidates({language:'km',topic:'gl',now}),e=>e.message.includes('[redacted]')&&!e.message.includes('abcdefghijk'))
})
