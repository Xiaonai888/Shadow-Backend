import test from 'node:test'
import assert from 'node:assert/strict'
import { createSocialPromotionExceptions } from '../src/services/socialMedia/socialPromotionExceptions.service.js'

const A='10000000-0000-4000-8000-000000000001',B='10000000-0000-4000-8000-000000000002'
const story={id:A,kind:'story',name:'Story',language:'km',image_url:'https://example.com/a.webp',author_name:'Author',blocked:true}
function mock(response){const calls=[];return {calls,api:createSocialPromotionExceptions({rpc:async(name,args)=>{calls.push({name,args});return typeof response==='function'?response(name,args):{data:response}}})}}
test('all five languages are passed to SQL before pagination',async()=>{
  for(const language of ['km','en','zh','ja','ko']){
    const {api,calls}=mock({items:[{...story,language}],page:2,hasMore:true})
    const r=await api.list({kind:'story',language,page:'2',q:' Title '})
    assert.equal(r.items[0].language,language);assert.equal(r.hasMore,true)
    assert.deepEqual(calls[0].args,{p_kind:'story',p_language:language,p_search:'Title',p_page:2,p_blocked_only:true})
  }
})
test('authors are global, not restricted by language',async()=>{
  const {api,calls}=mock({items:[{...story,kind:'author',language:null}],page:1,hasMore:false})
  await assert.rejects(api.list({kind:'author',language:'km'}),/LIST_INVALID/)
  await api.list({kind:'author'});assert.equal(calls[0].args.p_language,'all')
})
test('search and blocked listing are separate modes',async()=>{
  const {api,calls}=mock({items:[{...story,blocked:false}],page:1,hasMore:false})
  await api.list({kind:'story'},false);assert.equal(calls[0].args.p_blocked_only,false)
  await assert.rejects(api.list({kind:'story'}),/RESPONSE_INVALID/)
})
test('rejects pages beyond ten items and mixed language response',async()=>{
  await assert.rejects(mock({items:Array(11).fill(story),page:1,hasMore:false}).api.list(),/RESPONSE_INVALID/)
  await assert.rejects(mock({items:[story],page:1,hasMore:false}).api.list({language:'en'}),/RESPONSE_INVALID/)
})
test('invalid pagination, scope and search do not hit database',async()=>{
  const {api,calls}=mock(null)
  for(const q of [{page:0},{page:'1.5'},{page:10001},{kind:'other'},{language:'xx'},{q:'a'.repeat(121)}])await assert.rejects(api.list(q))
  assert.equal(calls.length,0)
})
test('block author is global and reports queued cancellations',async()=>{
  const {api,calls}=mock({state:'blocked',changed:true,cancelled:4})
  assert.deepEqual(await api.change({kind:'author',id:A},true),{state:'blocked',changed:true,cancelled:4})
  assert.deepEqual(calls[0].args,{p_kind:'author',p_target_id:A,p_block:true})
})
test('remove is idempotent and missing target is rejected',async()=>{
  assert.equal((await mock({state:'removed',changed:false,cancelled:0}).api.change({kind:'story',id:A},false)).changed,false)
  await assert.rejects(mock({state:'not_found',changed:false,cancelled:0}).api.change({kind:'story',id:A},true),e=>e.status===404)
})
test('planner filter uses database allow list and never fails open',async()=>{
  const {api,calls}=mock([B]);assert.deepEqual([...await api.allowedStoryIds([A,B,A])],[B])
  assert.deepEqual(calls[0].args.p_story_ids,[A,B]);assert.equal((await api.allowedStoryIds([])).size,0)
  await assert.rejects(mock([B]).api.allowedStoryIds([A]),/RESPONSE_INVALID/)
  await assert.rejects(mock(()=>({error:{message:'secret'}})).api.allowedStoryIds([A]),/DATABASE_FAILED/)
})
test('API response does not expose additional database fields',async()=>{
  const {api}=mock({items:[{...story,token_ciphertext:'private'}],page:1,hasMore:false})
  assert.equal(Object.hasOwn((await api.list()).items[0],'token_ciphertext'),false)
})
