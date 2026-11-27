import test from 'node:test'
import assert from 'node:assert/strict'
import { createSocialPromotionConnectionStore } from '../src/services/socialMedia/socialPromotionConnectionStore.service.js'
import { createSocialPromotionAdmin } from '../src/services/socialMedia/socialPromotionAdmin.service.js'
import { encryptSocialToken, decryptSocialToken } from '../src/services/socialMedia/tokenVault.service.js'

const id='10000000-0000-4000-8000-000000000001'
const clock=()=>Date.parse('2026-11-27T12:00:00Z')
const row={id,platform:'facebook',status:'connected',token_ciphertext:'never-return',owner_id:'shadow',external_id:'123',display_name:'Shadow'}
function mock(data,error=null){
  const calls=[]
  const q={then(resolve,reject){return Promise.resolve({data,error}).then(resolve,reject)}}
  for(const name of ['select','upsert','update','eq','order','range','single','maybeSingle'])q[name]=(...args)=>{calls.push([name,...args]);return q}
  return {calls,db:{from(name){calls.push(['from',name]);return q}}}
}
function store(db,overrides={}){
  return createSocialPromotionConnectionStore({db,clock,verifyFacebook:async({pageId})=>({platform:'facebook',externalId:pageId,displayName:'Shadow'}),verifyInstagram:async({pageId,instagramId})=>({platform:'instagram',externalId:instagramId,linkedPageId:pageId,displayName:'Shadow IG'}),encryptToken:(token,context)=>{assert.equal(context.ownerId,'shadow');return 'encrypted-'+context.platform},...overrides})
}
const input={platform:'facebook',pageId:'123',token:'private-token'}
const rule={connectionId:id,name:'Rule',language:'km',enabled:true,publishTimes:['07:00','11:00','18:00'],dailyLimit:3}
function admin(db,overrides={}){return createSocialPromotionAdmin({db,clock,rules:{create:async()=>({id,language:'km'}),replace:async()=>({id,language:'km'}),...overrides}})}
test('verified connection stores encrypted token and returns safe projection',async()=>{
  const {db,calls}=mock(row)
  const result=await store(db).connect(input)
  const written=calls.find(x=>x[0]==='upsert')[1]
  assert.equal(written.token_ciphertext,'encrypted-facebook')
  assert.equal(written.owner_type,'admin')
  assert.equal(written.status,'connected')
  assert.equal(result.external_id,'123')
  assert.equal(Object.hasOwn(result,'token_ciphertext'),false)
  assert.ok(!JSON.stringify(calls).includes(input.token))
})
test('wrong account or expired credential is rejected without database write',async()=>{
  const {db,calls}=mock(row)
  await assert.rejects(store(db,{verifyFacebook:async()=>({platform:'facebook',externalId:'456',displayName:'Other'})}).connect(input),/IDENTITY_MISMATCH/)
  await assert.rejects(store(db).connect({...input,expiresAt:'2026-11-26T12:00:00Z'}),/INPUT_INVALID/)
  assert.equal(calls.length,0)
})
test('instagram is bound to verified account and linked page',async()=>{
  const {db,calls}=mock({...row,platform:'instagram',external_id:'456'})
  await store(db).connect({...input,platform:'instagram',instagramId:'456'})
  assert.equal(calls.find(x=>x[0]==='upsert')[1].token_ciphertext,'encrypted-instagram')
  await assert.rejects(store(db,{verifyInstagram:async()=>({platform:'instagram',externalId:'456',linkedPageId:'789',displayName:'Other'})}).connect({...input,platform:'instagram',instagramId:'456'}),/IDENTITY_MISMATCH/)
})
test('Instagram connection encrypts credential and isolates it from Facebook',async()=>{
  process.env.SOCIAL_MEDIA_TOKEN_KEY='a'.repeat(64)
  const {db,calls}=mock({...row,platform:'instagram',external_id:'456'})
  const result=await store(db,{encryptToken:encryptSocialToken}).connect({...input,platform:'instagram',instagramId:'456'})
  const written=calls.find(x=>x[0]==='upsert')[1]
  const context={ownerType:'admin',ownerId:'shadow',platform:'instagram',externalId:'456'}
  assert.equal(decryptSocialToken(written.token_ciphertext,context),input.token)
  assert.throws(()=>decryptSocialToken(written.token_ciphertext,{...context,platform:'facebook'}),/DECRYPT_FAILED/)
  assert.throws(()=>decryptSocialToken(written.token_ciphertext,{...context,externalId:'789'}),/DECRYPT_FAILED/)
  assert.equal(result.platform,'instagram')
  assert.equal(Object.hasOwn(result,'token_ciphertext'),false)
  assert.ok(!JSON.stringify(calls).includes(input.token))
})
test('revocation removes local token and restricts owner',async()=>{
  const {db,calls}=mock({...row,status:'revoked'})
  await store(db).revoke(id)
  assert.equal(calls.find(x=>x[0]==='update')[1].token_ciphertext,null)
  assert.ok(calls.some(x=>x.join('|')==='eq|owner_type|admin'))
  assert.ok(calls.some(x=>x.join('|')==='eq|owner_id|shadow'))
})
test('connections list paginates ten and never returns ciphertext',async()=>{
  const {db,calls}=mock(Array(11).fill(row))
  const result=await admin(db).listConnections({page:'2',platform:'facebook'})
  assert.equal(result.items.length,10)
  assert.equal(result.hasMore,true)
  assert.deepEqual(calls.find(x=>x[0]==='range'),['range',10,20])
  assert.ok(!JSON.stringify(result).includes('never-return'))
  await assert.rejects(admin(db).listConnections({page:'0'}),/PAGE_INVALID/)
})
test('rule rejects disabled connection and limits above three',async()=>{
  const {db}=mock({...row,status:'revoked'})
  await assert.rejects(admin(db).createRule(rule),/NOT_ACTIVE/)
  await assert.rejects(admin(db).createRule({...rule,dailyLimit:4}),/MAX_3/)
  await assert.rejects(admin(db).createRule({...rule,postFormat:'full'}),/FORMAT_AUTOMATIC/)
})
test('rule creation and optimistic revision conflict',async()=>{
  const {db}=mock(row)
  assert.equal((await admin(db).createRule(rule)).id,id)
  await assert.rejects(admin(db,{replace:async()=>{throw new Error('SOCIAL_RULE_STALE')}}).replaceRule(id,rule,'2026-11-27T12:00:00Z'),e=>e.status===409)
})
test('cancel is scoped to queued jobs, not in-progress jobs',async()=>{
  const {db,calls}=mock(null)
  await assert.rejects(admin(db).cancelJob(id),e=>e.status===409)
  assert.ok(calls.some(x=>x.join('|')==='eq|status|queued'))
  assert.ok(calls.some(x=>x.join('|')==='eq|owner_id|shadow'))
})
test('history returns ordered job items, no worker claim or secrets',async()=>{
  const {db}=mock([{...row,worker_claim_id:'private',social_media_job_items:[{position:2,story_id:'B',episode_id:'2'},{position:1,story_id:'A',episode_id:'1'}]}])
  const result=await admin(db).listJobs({status:'published'})
  assert.equal(result.items[0].items[0].position,1)
  assert.ok(!JSON.stringify(result).includes('private'))
  assert.ok(!JSON.stringify(result).includes('never-return'))
})
