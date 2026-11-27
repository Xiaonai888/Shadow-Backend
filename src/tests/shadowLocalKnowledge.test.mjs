import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeShadowLocalKnowledge,createShadowLocalKnowledgeDictionary } from '../services/shadowAi/local/shadowLocalKnowledge.js'
import { createShadowLocalKnowledgeStore } from '../services/shadowAi/local/shadowLocalKnowledgeStore.service.js'
import { createShadowLocalKnowledgeAdmin } from '../services/shadowAi/local/shadowLocalKnowledgeAdmin.service.js'
import { createShadowLocalCoreV2 } from '../services/shadowAi/local/shadowLocalCoreV2.service.js'

const row={group:'questions',alias:'តើតម្លៃប៉ុន្មាន',canonical:'price'}
const snapshot={version:2,aliases:[row]}
const fakeDb=handler=>({rpc(name,args){return {abortSignal(){return Promise.resolve(handler(name,args))}}}})
const actor='11111111-1111-4111-8111-111111111111'

test('normalize aliases, remove exact seed duplicates and duplicate entries',()=>{
  assert.deepEqual(normalizeShadowLocalKnowledge([row,{...row,alias:` ${row.alias} `},{group:'editions',alias:'Normal',canonical:'standard'}]),[row])
})
test('reject seed conflicts, new conflicts, unsupported canonicals and non-text values',()=>{
  for(const rows of [[{group:'editions',alias:'Normal',canonical:'limited'}],[row,{...row,canonical:'stock'}],[{...row,canonical:'payment'}],[{...row,group:'answers'}],[{...row,alias:'@reader'}],[{...row,alias:'012345678'}],[{...row,alias:'https://test.example'}],[{...row,alias:'hello\nworld'}].map(r=>({...r,alias:'hello\u202eworld'})),[{...row,extra:'secret'}],Array(251).fill(row)]) assert.throws(()=>normalizeShadowLocalKnowledge(rows))
})
test('built-in aliases remain available and custom aliases scoped',()=>{
  const dictionary=createShadowLocalKnowledgeDictionary(snapshot)
  assert.equal(dictionary.lookup('questions',row.alias),'price')
  assert.equal(dictionary.lookup('fields',row.alias),null)
  assert.equal(dictionary.lookup('editions','normal'),'standard')
  assert.ok(dictionary.aliases('questions').includes(row.alias))
  assert.equal(dictionary.version,'shadow-local-km-en-v1-knowledge-2')
})
test('new alias works with actual local V2 output and no network',async()=>{
  const run=createShadowLocalCoreV2({dictionary:createShadowLocalKnowledgeDictionary(snapshot)})
  const result=await run({role:'preorder',task:'reader_message',actorUserId:actor,input:{message:row.alias,current_draft:{items:[]},catalog:{books:[],delivery_companies:[],signature_enabled:false}},schema:{type:'object',additionalProperties:false}})
  assert.equal(result.data.intent,'question');assert.equal(result.data.question,'price');assert.equal(result.data.items,null);assert.equal(result.usage.inputTokens,null)
})
test('one cold read shared by concurrent callers, warm cache and expiration',async()=>{
  let calls=0,time=1000
  const cache=createShadowLocalKnowledgeStore({readSnapshot:async()=>{calls++;return {...snapshot,version:calls+1}},now:()=>time})
  const results=await Promise.all([cache.getDictionary(),cache.getDictionary(),cache.getDictionary()]);assert.equal(calls,1);assert.equal(results[0],results[2]);assert.equal(await cache.getDictionary(),results[0]);time+=30001;assert.notEqual(await cache.getDictionary(),results[0]);assert.equal(calls,2)
})
test('invalid snapshot falls back, retries bounded',async()=>{
  let calls=0,time=1000
  const cache=createShadowLocalKnowledgeStore({readSnapshot:async()=>{calls++;return calls===1?{version:2,aliases:[{...row,canonical:'payment'}]}:snapshot},now:()=>time})
  assert.equal((await cache.getDictionary()).lookup('questions',row.alias),null);await cache.getDictionary();assert.equal(calls,1);time+=15001;assert.equal((await cache.getDictionary()).lookup('questions',row.alias),'price')
})
test('invalidate discards in-flight stale version',async()=>{
  let resolve,calls=0
  const cache=createShadowLocalKnowledgeStore({readSnapshot:()=>++calls===1?new Promise(r=>{resolve=r}):Promise.resolve({version:3,aliases:[]})})
  const pending=cache.getDictionary();await Promise.resolve();cache.invalidate();const latest=await cache.getDictionary();resolve(snapshot);assert.equal((await pending).lookup('questions',row.alias),null);assert.equal(await cache.getDictionary(),latest);assert.match(latest.version,/knowledge-3$/)
})
test('read failures do not cause repeated requests during retry interval',async()=>{
  let calls=0
  const cache=createShadowLocalKnowledgeStore({readSnapshot:async()=>{calls++;throw new Error('offline')}})
  const d=await cache.getDictionary();assert.equal(d.lookup('editions','normal'),'standard');await cache.getDictionary();assert.equal(calls,1)
})
test('publish validates and sends canonical snapshot with optimistic lock',async()=>{
  let calls=0,invalidations=0
  const service=createShadowLocalKnowledgeAdmin({db:fakeDb((name,args)=>{calls++;assert.equal(name,'shadow_ai_local_knowledge_publish_v1');assert.deepEqual(args,{p_expected_version:1,p_aliases:[row],p_admin_id:'owner',p_source_version:null});return {data:{ok:true,version:2,changed:true}}}),invalidate:()=>invalidations++})
  assert.deepEqual(await service.publish('owner',{expected_version:1,aliases:[row,row]}),{version:2,changed:true});assert.equal(calls,1);assert.equal(invalidations,1)
  await assert.rejects(service.publish('owner',{expected_version:2,aliases:[{...row,canonical:'invalid'}]}),{code:'SHADOW_AI_KNOWLEDGE_INVALID'});assert.equal(calls,1)
})
test('stale publish returns conflict and does not invalidate',async()=>{
  let count=0
  const service=createShadowLocalKnowledgeAdmin({db:fakeDb(()=>({data:{ok:false,code:'SHADOW_AI_KNOWLEDGE_CONFLICT'}})),invalidate:()=>count++})
  await assert.rejects(service.publish('owner',{expected_version:1,aliases:[row]}),{statusCode:409});assert.equal(count,0)
})
test('rollback copies a prior immutable snapshot and increments version',async()=>{
  const service=createShadowLocalKnowledgeAdmin({db:fakeDb((name,args)=>{if(name.endsWith('read_v1')){assert.equal(args.p_version,1);return {data:{version:1,aliases:[]}}}assert.equal(args.p_source_version,1);assert.equal(args.p_expected_version,2);assert.deepEqual(args.p_aliases,[]);return {data:{ok:true,version:3,changed:true}}})})
  assert.deepEqual(await service.rollback('owner',{expected_version:2,source_version:1}),{version:3,changed:true})
})
test('invalid version and missing history fail safely',async()=>{
  const service=createShadowLocalKnowledgeAdmin({db:fakeDb(()=>({data:null}))})
  await assert.rejects(service.read(0),{statusCode:400});await assert.rejects(service.read(2),{statusCode:404});await assert.rejects(service.rollback('owner',{expected_version:1,source_version:1}),{statusCode:400})
})
