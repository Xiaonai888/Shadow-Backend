import test from 'node:test'
import assert from 'node:assert/strict'
import {AUTHOR_AUTO_POST_DEFAULTS as defaults,AUTHOR_AUTO_POST_PLATFORMS,normalizeAuthorAutoPostSettings as normalize,createAuthorAutoPostSettingsService} from '../src/services/socialMedia/authorAutoPostSettings.service.js'

const make=patch=>({...defaults,...patch})
const id='00000000-0000-0000-0000-000000000001'
test('defaults and five platforms',()=>{assert.deepEqual(normalize(make()),defaults);assert.equal(AUTHOR_AUTO_POST_PLATFORMS.length,5)})
test('slider accepts all ten steps',()=>{for(let i=10;i<=100;i+=10)assert.equal(normalize(make({content_percent:i,episode_filter:'free'})).content_percent,i)})
test('invalid slider values fail',()=>{for(const v of [0,15,110,'30',NaN])assert.throws(()=>normalize(make({content_percent:v})),/SETTINGS_INVALID/)})
test('locked content warning requires affirmative confirmation',()=>{assert.throws(()=>normalize(make({content_percent:100})),/CONFIRMATION_REQUIRED/);assert.equal(normalize(make({content_percent:100,locked_content_confirmed:true})).locked_content_confirmed,true)})
test('free content does not require warning',()=>{assert.equal(normalize(make({content_percent:100,episode_filter:'free'})).locked_content_confirmed,false)})
test('selected story IDs deduplicate and validate',()=>{assert.deepEqual(normalize(make({selection_mode:'selected',story_ids:[id,id]})).story_ids,[id]);assert.throws(()=>normalize(make({selection_mode:'selected'})));assert.throws(()=>normalize(make({story_ids:[id]})))})
test('reject invalid text and booleans',()=>{assert.throws(()=>normalize(make({header_text:'a'.repeat(301)})));assert.throws(()=>normalize(make({include_cover:'false'})))})
test('save uses one RPC and strips unauthorized fields',async()=>{const calls=[];const service=createAuthorAutoPostSettingsService({db:{rpc:async(...args)=>{calls.push(args);return {data:{state:'ok'},error:null}}}});await service.save(id,make({suspended_at:'bad',author_id:'other'}));assert.equal(calls.length,1);assert.equal(calls[0][1].p_user_id,id);assert.equal(Object.hasOwn(calls[0][1].p_settings,'suspended_at'),false);assert.equal(Object.hasOwn(calls[0][1].p_settings,'author_id'),false)})
test('get uses one RPC and rejects missing actor',async()=>{let count=0;const service=createAuthorAutoPostSettingsService({db:{rpc:async()=>{count++;return {data:{state:'ok'},error:null}}}});await service.get(id);assert.equal(count,1);assert.throws(()=>service.get(''),/UNAUTHORIZED/)})
test('stale and database errors are sanitized',async()=>{const service=createAuthorAutoPostSettingsService({db:{rpc:async()=>({data:{state:'stale_settings'},error:null})}});await assert.rejects(service.save(id,make()),e=>e.status===409);const broken=createAuthorAutoPostSettingsService({db:{rpc:async()=>({error:{message:'secret'}})}});await assert.rejects(broken.get(id),e=>e.status===503&&!e.message.includes('secret'))})
