import test from 'node:test'
import assert from 'node:assert/strict'
import { validatePromotionSettings,buildSettingsUpdate,parsePromotionQueueQuery } from '../src/services/telegramPromotion/admin.service.js'
const version='2026-11-26T00:00:00.000Z'
const now='2026-11-26T01:00:00.000Z'
const current={updated_at:version,enabled:false,channel_id:null,enabled_at:null}
const input=patch=>({updated_at:version,...patch})
test('valid settings preserve approved field values',()=>assert.deepEqual(validatePromotionSettings(input({gap_seconds:300,schedule:[{day:0,time:'19:00',kind:'trending'}]})).patch,{gap_seconds:300,schedule:[{day:0,time:'19:00',kind:'trending'}]}))
test('reject invalid and duplicate slots',()=>{for(const schedule of [[{day:0,time:'25:00',kind:'short'}],[{day:0,time:'19:00',kind:'update'}],[{day:0,time:'19:00',kind:'short'},{day:0,time:'19:00',kind:'author'}]])assert.throws(()=>validatePromotionSettings(input({schedule})))})
test('reject secret injection and invalid gap',()=>{for(const patch of [{token:'secret'},{gap_seconds:0},{enabled:'true'}])assert.throws(()=>validatePromotionSettings(input(patch)))})
test('require HTTPS links',()=>assert.throws(()=>validatePromotionSettings(input({links:{register:'javascript:alert(1)',install:'https://example.com',tutorial:'https://example.com'}}))))
test('activation requires token and channel',()=>{assert.throws(()=>buildSettingsUpdate(current,input({enabled:true}),true,now));assert.throws(()=>buildSettingsUpdate(current,input({enabled:true,channel_id:'-100123'}),false,now));assert.equal(buildSettingsUpdate(current,input({enabled:true,channel_id:'-100123'}),true,now).enabled_at,now)})
test('resume preserves activation date and channel',()=>{const old={...current,channel_id:'-100123',enabled_at:version};assert.equal(buildSettingsUpdate(old,input({enabled:true}),true,now).enabled_at,version);assert.throws(()=>buildSettingsUpdate(old,input({channel_id:'-100456'}),true,now))})
test('stale settings version conflicts',()=>assert.throws(()=>buildSettingsUpdate({...current,updated_at:now},input({gap_seconds:600}),true,now),{status:409}))
test('queue filter is bounded and validated',()=>{assert.deepEqual(parsePromotionQueueQuery({language:'km',status:'ready',page:'2'}),{language:'km',status:'ready',kind:null,page:2});for(const q of [{language:'all'},{language:'km',page:'1001'},{language:'km',status:'unknown'}])assert.throws(()=>parsePromotionQueueQuery(q))})
