import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowGeminiTeacher } from '../services/shadowAi/gemini/shadowGeminiTeacher.service.js'
import { listShadowGeminiExamples } from '../services/shadowAi/gemini/shadowGeminiExamples.js'
import { shadowGeminiConfig } from '../services/shadowAi/gemini/shadowGeminiConfig.js'

const env = { SHADOW_GEMINI_ENABLED:'true', SHADOW_GEMINI_FREE_PROJECT_CONFIRMED:'true', GEMINI_API_KEY:'fake_key_for_unit_testing_only', SHADOW_GEMINI_DAILY_LIMIT:'450' }
const reply = (question='price') => new Response(JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({question})}]}}]}))
function fixture(options={}) {
  const calls=[]
  const reserve=async args=>{calls.push(['reserve',args]);return true}
  const fetchImpl=async (url,request)=>{calls.push(['fetch',url,request]);return reply()}
  return {calls,run:createShadowGeminiTeacher({env,reserve,fetchImpl,...options})}
}
test('defaults disabled and requires owner confirmation',()=>{
  assert.throws(()=>shadowGeminiConfig({}),{code:'SHADOW_AI_GEMINI_DISABLED'})
  assert.throws(()=>shadowGeminiConfig({...env,SHADOW_GEMINI_FREE_PROJECT_CONFIRMED:'false'}),{code:'SHADOW_AI_GEMINI_FREE_PROJECT_REQUIRED'})
})
test('invalid key and limits fail closed',()=>{
  assert.throws(()=>shadowGeminiConfig({...env,GEMINI_API_KEY:'bad'}),{code:'SHADOW_AI_GEMINI_NOT_CONFIGURED'})
  for(const limit of ['0','451','500','1e2','-1']) assert.throws(()=>shadowGeminiConfig({...env,SHADOW_GEMINI_DAILY_LIMIT:limit}),{code:'SHADOW_AI_GEMINI_LIMIT_INVALID'})
})
test('fixed examples contain no submitted chat data',async()=>{
  const f=fixture();await assert.rejects(f.run('name: private data'),{code:'SHADOW_AI_GEMINI_EXAMPLE_INVALID'});await assert.rejects(f.run({id:'price_km',text:'private'}),{code:'SHADOW_AI_GEMINI_EXAMPLE_INVALID'});assert.equal(f.calls.length,0);assert.equal(listShadowGeminiExamples().length,11)
})
test('fixed model, reserved before request, key header, no tools or chat context',async()=>{
  const f=fixture();const r=await f.run('price_km');assert.deepEqual(f.calls[0],['reserve',{dailyLimit:450}]);const [,url,req]=f.calls[1];assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');assert.equal(req.headers['x-goog-api-key'],env.GEMINI_API_KEY);assert.equal(req.redirect,'error');assert.equal(JSON.parse(req.body).tools,undefined);assert.equal(req.body.includes(env.GEMINI_API_KEY),false);assert.equal(r.question,'price');assert.equal(r.knowledge_published,false);assert.equal(r.test_only,true)
})
test('quota denied means no network',async()=>{const f=fixture({reserve:async()=>false});await assert.rejects(f.run('price_km'),{code:'SHADOW_AI_GEMINI_QUOTA'});assert.equal(f.calls.length,0)})
test('provider limit no retry and cooldown',async()=>{let attempts=0;const f=fixture({fetchImpl:async()=>{attempts++;return new Response('',{status:429})}});await assert.rejects(f.run('price_km'),{code:'SHADOW_AI_GEMINI_PROVIDER_LIMIT'});await assert.rejects(f.run('price_km'),{code:'SHADOW_AI_GEMINI_BUSY'});assert.equal(attempts,1)})
test('invalid category rejected',async()=>{const f=fixture({fetchImpl:async()=>reply('buy_now')});await assert.rejects(f.run('price_km'),{code:'SHADOW_AI_GEMINI_INVALID_RESPONSE'})})
test('blocked and oversized output rejected',async()=>{for(const response of [new Response(JSON.stringify({candidates:[]})),new Response('x'.repeat(33000))]){const f=fixture({fetchImpl:async()=>response});await assert.rejects(f.run('price_km'),{code:'SHADOW_AI_GEMINI_INVALID_RESPONSE'})}})
test('single in flight and release on completion',async()=>{let release;const f=fixture({reserve:()=>new Promise(r=>{release=r})});const pending=f.run('price_km');await assert.rejects(f.run('stock_km'),{code:'SHADOW_AI_GEMINI_BUSY'});release(true);assert.equal((await pending).question,'price')})
test('network error is sanitized without leaking key',async()=>{const f=fixture({fetchImpl:async()=>{throw new Error(env.GEMINI_API_KEY)}});await assert.rejects(f.run('price_km'),{code:'SHADOW_AI_GEMINI_UNAVAILABLE',message:'SHADOW_AI_GEMINI_UNAVAILABLE'})})
