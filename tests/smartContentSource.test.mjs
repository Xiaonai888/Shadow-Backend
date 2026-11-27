import test from 'node:test'
import assert from 'node:assert/strict'
import {createCandidateCache} from '../src/services/smartContent/candidateCache.service.js'
import {createSmartContentSource} from '../src/services/smartContent/contentSource.service.js'

const seed='2026-11-27:solo'
const id='12345678-1234-1234-1234-123456789012'
const empty=()=>({scanned:0,candidates:[],history:[],captions:[]})
function fixture(fn=()=>empty()){
  const calls=[]
  const source=createSmartContentSource({rpc:async(name,args)=>{calls.push({name,args});return {data:await fn(name,args)}}})
  return {source,calls}
}
test('all five languages reach neutral source independently',async()=>{
  const {source,calls}=fixture()
  for(const language of ['km','en','zh','ja','ko'])await source.candidatePage({language,seed})
  assert.deepEqual(calls.map(x=>x.args.p_language),['km','en','zh','ja','ko'])
  assert.ok(calls.every(x=>x.args.p_history_scope==='neutral'))
})
test('identical neutral calls coalesce and cached values are isolated',async()=>{
  const {source,calls}=fixture(()=>({...empty(),candidates:[{story:{id}}],scanned:1}))
  const request={language:'en',seed}
  const [first,second]=await Promise.all([source.candidatePage(request),source.candidatePage(request)])
  first.candidates[0].story.id='changed'
  assert.equal(second.candidates[0].story.id,id)
  assert.equal((await source.candidatePage(request)).candidates[0].story.id,id)
  assert.equal(calls.length,1)
  source.clearCache();await source.candidatePage(request);assert.equal(calls.length,2)
})
test('Telegram compatibility is uncached and isolated from neutral history',async()=>{
  const {source,calls}=fixture((_,args)=>({...empty(),history:args.p_history_scope==='telegram'?[{story_id:id}]:[]}))
  const request={language:'km',seed}
  await source.candidatePage(request)
  for(let i=0;i<2;i++)assert.equal((await source.candidatePage({...request,historyScope:'telegram'})).history.length,1)
  assert.deepEqual((await source.candidatePage(request)).history,[])
  assert.equal(calls.length,3)
})
test('neutral source rejects leaked platform history',async()=>{
  const {source}=fixture(()=>({...empty(),history:[{story_id:id}]}))
  await assert.rejects(source.candidatePage({language:'km',seed}),/HISTORY_ISOLATION/)
})
test('filters are normalized and passed before pagination',async()=>{
  const {source,calls}=fixture()
  await source.candidatePage({language:'zh',seed,offset:100,storyIds:[id,id],authorIds:[id],storyTypes:['manga','novel']})
  assert.deepEqual(calls[0].args.p_story_ids,[id]);assert.deepEqual(calls[0].args.p_author_ids,[id]);assert.deepEqual(calls[0].args.p_story_types,['manga','novel']);assert.equal(calls[0].args.p_offset,100)
})
test('invalid filters and Telegram language reject before database request',async()=>{
  const {source,calls}=fixture()
  for(const options of [{language:'xx'},{language:'ja',historyScope:'telegram'},{language:'km',historyScope:'telegram',storyIds:[id]},{language:'km',storyTypes:['chat']},{language:'km',offset:1},{language:'km',storyIds:['bad']}])await assert.rejects(source.candidatePage({seed,...options}),TypeError)
  assert.equal(calls.length,0)
})
test('Manga uses existing V2 RPC without new database reader',async()=>{
  const {source,calls}=fixture(()=>[])
  assert.deepEqual(await source.mangaPages(id),[])
  assert.deepEqual(calls,[{name:'telegram_promotion_v2_manga_pages',args:{p_episode_id:id}}])
})
test('cache expires and respects entry and byte bounds',async()=>{
  let now=0,n=0
  const cache=createCandidateCache({ttlMs:10,maxEntries:2,maxBytes:80,clock:()=>now})
  const load=async()=>({n:++n})
  await cache.get('a',load);await cache.get('b',load);await cache.get('c',load)
  assert.equal(cache.stats().entries,2)
  assert.equal((await cache.get('a',load)).n,4)
  now=11;assert.equal(cache.stats().entries,0)
  await cache.get('large',async()=>({s:'x'.repeat(100)}));assert.equal(cache.stats().bytes,0)
})
test('failed reads are not cached',async()=>{
  let calls=0
  const source=createSmartContentSource({rpc:async()=>++calls===1?{error:{message:'private'}}:{data:empty()}})
  await assert.rejects(source.candidatePage({language:'ko',seed}),/^Error: SMART_CONTENT_SOURCE_FAILED$/)
  await source.candidatePage({language:'ko',seed});assert.equal(calls,2)
})
