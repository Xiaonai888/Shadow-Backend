import test from 'node:test'
import assert from 'node:assert/strict'
import {createHmac} from 'node:crypto'
import {createSocialOAuthAccountStore} from '../src/services/socialMedia/socialOAuthAccountStore.service.js'
import {createFacebookOAuthGrants} from '../src/services/socialMedia/facebookOAuthGrants.service.js'
import {createSocialOAuthAdmin} from '../src/services/socialMedia/socialOAuthAdmin.service.js'
import {decryptSocialToken} from '../src/services/socialMedia/tokenVault.service.js'

process.env.SOCIAL_MEDIA_TOKEN_KEY='a'.repeat(64)
const now=Date.parse('2026-11-28T06:00:00Z'),clock=()=>now
const expiresAt=new Date(now+86400000).toISOString()
const context={actorId:'admin1',sessionBinding:'private-session',provider:'facebook'}
const state='a'.repeat(43)
const env={SOCIAL_META_APP_ID:'123',SOCIAL_META_APP_SECRET:'test-secret',SOCIAL_META_GRAPH_VERSION:'v27.0',SOCIAL_META_LOGIN_CONFIG_ID:'456',SOCIAL_META_OAUTH_REDIRECT_URI:'https://admin.example.com/social-oauth/callback'}
const fb={platform:'facebook',externalId:'123',displayName:'Shadow',token:'page-token',expiresAt:null}
const ig={platform:'instagram',externalId:'789',displayName:'shadow_ig',token:'long-user-token',expiresAt}
const page=(id='123',tasks=['CREATE_CONTENT'])=>({pageId:id,displayName:'Shadow '+id,pageToken:'page-token-'+id,tasks,instagram:{id:'789'+id,username:'shadow_'+id}})
function setup(overrides={}){
  const calls=[]
  const deps={clock,stateStore:{issue:async c=>{calls.push(['issue',c]);return state},consume:async(c,s)=>{calls.push(['consume',c,s]);assert.equal(s,state)}},facebook:{authorizationUrl:s=>'https://www.facebook.com/dialog/oauth?state='+s,exchangeCode:async c=>{calls.push(['exchange',c]);return {token:'short',expiresIn:3600}},extendUserToken:async t=>{calls.push(['extend',t]);return {token:'long-user-token',expiresIn:86400}},accountPage:async(t,a)=>{calls.push(['page',t,a]);return {pages:[page()],after:null}}},grantedPermissions:async t=>{calls.push(['grants',t]);return {facebook:true,instagram:true}},accountStore:{importAdmin:async rows=>{calls.push(['import',rows]);return {saved:rows.length,skipped:0}}},...overrides}
  return {calls,deps,service:createSocialOAuthAdmin(deps)}
}
test('state start binds authenticated context',async()=>{
  const {service,calls}=setup();assert.equal((await service.start(context)).authorizationUrl,'https://www.facebook.com/dialog/oauth?state='+state);assert.deepEqual(calls,[['issue',context]])
})
test('callback consumes state before exchanging code and stores distinct platform tokens',async()=>{
  const {service,calls}=setup();const result=await service.complete(context,{state,code:'code'});assert.deepEqual(calls.map(x=>x[0]),['consume','exchange','extend','grants','page','import']);assert.deepEqual(result,{pagesFound:1,facebookFound:1,instagramFound:1,skippedPages:0,saved:2,skipped:0});const rows=calls.at(-1)[1];assert.equal(rows[0].token,'page-token-123');assert.equal(rows[1].token,'long-user-token');assert.equal(rows[1].expiresAt,expiresAt);assert.ok(!JSON.stringify(result).includes('token'))
})
test('state failure prevents Meta and database import',async()=>{
  const {service,calls}=setup({stateStore:{issue:async()=>state,consume:async()=>{throw new Error('state rejected')}}});await assert.rejects(service.complete(context,{state,code:'code'}),/state rejected/);assert.equal(calls.length,0)
})
test('insufficient permissions prevent enumeration',async()=>{
  const {service,calls}=setup({grantedPermissions:async()=>({facebook:false,instagram:false})});await assert.rejects(service.complete(context,{state,code:'code'}),/PUBLISH_PERMISSIONS_REQUIRED/);assert.ok(!calls.some(x=>x[0]==='page'||x[0]==='import'))
})
test('denied Instagram permission and no content task are skipped',async()=>{
  const base=setup();const {service,calls}=setup({facebook:{...base.deps.facebook,accountPage:async()=>({pages:[page('123',['PROFILE_PLUS_CREATE_CONTENT']),page('456',['ANALYZE'])],after:null})},grantedPermissions:async()=>({facebook:true,instagram:false})});const result=await service.complete(context,{state,code:'code'});assert.equal(result.skippedPages,1);assert.equal(result.facebookFound,1);assert.equal(result.instagramFound,0);assert.equal(calls.at(-1)[1].length,1)
})
test('paging imports once after complete enumeration',async()=>{
  const base=setup();const seen=[];const {service,calls}=setup({facebook:{...base.deps.facebook,accountPage:async(t,a)=>{seen.push(a);return a===null?{pages:[page('123')],after:'cursor'}:{pages:[page('456')],after:null}}}});assert.equal((await service.complete(context,{state,code:'code'})).saved,4);assert.deepEqual(seen,[null,'cursor']);assert.equal(calls.filter(x=>x[0]==='import').length,1)
})
test('paging limit fails closed before partial save',async()=>{
  const base=setup();let n=0;const {service,calls}=setup({facebook:{...base.deps.facebook,accountPage:async()=>({pages:[page(String(++n))],after:'cursor'+n})}});await assert.rejects(service.complete(context,{state,code:'code'}),/ACCOUNT_LIMIT/);assert.equal(n,4);assert.ok(!calls.some(x=>x[0]==='import'))
})
test('duplicate page from Meta is rejected',async()=>{
  const base=setup();const {service,calls}=setup({facebook:{...base.deps.facebook,accountPage:async()=>({pages:[page(),page()],after:null})}});await assert.rejects(service.complete(context,{state,code:'code'}),/ACCOUNT_DUPLICATE/);assert.ok(!calls.some(x=>x[0]==='import'))
})
test('real vault encryption, owner-bound context and single bulk RPC',async()=>{
  const calls=[];const service=createSocialOAuthAccountStore({clock,db:{rpc:async(name,args)=>{calls.push([name,args]);return {data:{saved:2,skipped:0}}}}});assert.deepEqual(await service.importAdmin([fb,ig]),{saved:2,skipped:0});assert.equal(calls.length,1);assert.equal(calls[0][0],'social_oauth_import_admin_v2');const rows=calls[0][1].p_rows;assert.ok(!JSON.stringify(rows).includes(fb.token));assert.ok(!JSON.stringify(rows).includes(ig.token));for(const [i,a] of [fb,ig].entries()){assert.equal(decryptSocialToken(rows[i].token_ciphertext,{ownerType:'admin',ownerId:'shadow',platform:a.platform,externalId:a.externalId}),a.token);assert.throws(()=>decryptSocialToken(rows[i].token_ciphertext,{ownerType:'author',ownerId:'some-author',platform:a.platform,externalId:a.externalId}),/DECRYPT_FAILED/);assert.equal(Object.hasOwn(rows[i],'enabled'),false)}
})
test('store rejects duplicate, malformed and expired credentials before any RPC',async()=>{
  let n=0;const service=createSocialOAuthAccountStore({clock,db:{rpc:async()=>{n++;return {data:{saved:1,skipped:0}}}}});for(const rows of [[fb,fb],[{...ig,expiresAt:null}],[{...ig,expiresAt:new Date(now-1000).toISOString()}],[{...fb,platform:'threads'}],[{...fb,token:'bad token'}]])await assert.rejects(service.importAdmin(rows),/IMPORT_INVALID/);assert.equal(n,0)
})
test('skip counts preserved and empty batch makes no DB request',async()=>{
  let n=0;const service=createSocialOAuthAccountStore({clock,db:{rpc:async()=>{n++;return {data:{saved:0,skipped:1}}}}});assert.deepEqual(await service.importAdmin([]),{saved:0,skipped:0});assert.deepEqual(await service.importAdmin([fb]),{saved:0,skipped:1});assert.equal(n,1)
})
test('unexpected RPC result fails without leaking secrets',async()=>{
  const service=createSocialOAuthAccountStore({clock,db:{rpc:async()=>({error:{message:'private-token'}})}});await assert.rejects(service.importAdmin([fb]),e=>e.message==='SOCIAL_OAUTH_IMPORT_DATABASE_FAILED')
})
test('permissions fetched only from fixed Meta endpoint with bearer and proof',async()=>{
  const scopes=['pages_show_list','pages_manage_posts','pages_read_engagement','instagram_basic','instagram_content_publish'];const grant=createFacebookOAuthGrants({env,fetchImpl:async(url,init)=>{assert.equal(url.origin,'https://graph.facebook.com');assert.equal(url.pathname,'/v27.0/me/permissions');assert.equal(url.searchParams.get('appsecret_proof'),createHmac('sha256','test-secret').update('user-token').digest('hex'));assert.equal(url.searchParams.has('access_token'),false);assert.equal(init.headers.Authorization,'Bearer user-token');assert.equal(init.redirect,'error');return {ok:true,json:async()=>({data:scopes.map(permission=>({permission,status:'granted'}))})}}});assert.deepEqual(await grant('user-token'),{facebook:true,instagram:true})
})
test('declined permission is not considered granted',async()=>{
  const grant=createFacebookOAuthGrants({env,fetchImpl:async()=>({ok:true,json:async()=>({data:[{permission:'pages_show_list',status:'granted'},{permission:'pages_read_engagement',status:'granted'},{permission:'pages_manage_posts',status:'granted'},{permission:'instagram_basic',status:'granted'},{permission:'instagram_content_publish',status:'declined'}]})})});assert.deepEqual(await grant('user-token'),{facebook:true,instagram:false})
})
