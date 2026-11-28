import {createHash,randomBytes,randomUUID} from 'node:crypto'
import {SocialOAuthError} from './socialOAuthState.service.js'
import {verifiedSocialOAuthContext} from './socialOAuthAdminFlow.service.js'
const providers=new Set(['facebook','threads'])
const platformKey=/^(facebook|instagram|threads):[0-9]{1,40}$/
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const statePattern=/^[A-Za-z0-9_-]{43}$/
const states=new Set(['pending','exchanging','review','approved','cancelled','failed','expired'])
const digest=v=>createHash('sha256').update(v).digest('hex')
const fail=(code,status=400)=>{throw new SocialOAuthError(code,status)}
function id(value){if(typeof value!=='string'||!uuid.test(value))fail('SOCIAL_LINK_ID_INVALID');return value.toLowerCase()}
function provider(value){if(!providers.has(value))fail('SOCIAL_OAUTH_PROVIDER_INVALID');return value}
function identity(req){
  const {context,connectionId}=verifiedSocialOAuthContext({...req,body:{}},'facebook')
  if(connectionId!==null)fail('SOCIAL_LINK_IDENTITY_INVALID')
  return {p_actor_id:context.actorId,p_session_hash:digest(context.sessionBinding)}
}
function counts(value){if(!value||![value.saved,value.skipped].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=200)||value.saved+value.skipped>200)fail('SOCIAL_LINK_RESPONSE_INVALID',503);return {saved:value.saved,skipped:value.skipped}}
export function createSocialOAuthLinkStore(db){
  if(!db?.rpc)throw new TypeError('SOCIAL_LINK_DB_REQUIRED')
  async function call(name,args={}){let r;try{r=await db.rpc(name,args)}catch{fail('SOCIAL_LINK_DATABASE_FAILED',503)}if(r?.error)fail('SOCIAL_LINK_DATABASE_FAILED',503);return r?.data}
  return {
    async issue(req,value){
      const owner=identity(req),p=provider(value),linkId=randomUUID(),state=randomBytes(32).toString('base64url')
      const ok=await call('social_oauth_link_issue_v7',{p_id:linkId,...owner,p_provider:p,p_state_hash:digest(state)})
      if(ok===false)fail('SOCIAL_LINK_LIMIT',429)
      if(ok!==true)fail('SOCIAL_LINK_RESPONSE_INVALID',503)
      return {id:linkId,state}
    },
    async claim(value,state){
      const p=provider(value);if(typeof state!=='string'||!statePattern.test(state))fail('SOCIAL_LINK_STATE_INVALID')
      const data=await call('social_oauth_link_claim_v7',{p_state_hash:digest(state),p_provider:p})
      if(data===null)fail('SOCIAL_LINK_EXPIRED_OR_USED',409)
      return id(data)
    },
    async stage(linkId,rows){if(!Array.isArray(rows)||rows.length<1||rows.length>200)fail('SOCIAL_LINK_NO_ACCOUNTS',422);if(await call('social_oauth_link_stage_v7',{p_id:id(linkId),p_rows:rows})!==true)fail('SOCIAL_LINK_EXPIRED_OR_USED',409)},
    async fail(linkId){return await call('social_oauth_link_fail_v7',{p_id:id(linkId)})===true},
    async status(req,linkId){
      const link=id(linkId),data=await call('social_oauth_link_status_v7',{p_id:link,...identity(req)})
      if(data===null)fail('SOCIAL_LINK_NOT_FOUND',404)
      if(data?.id!==link||!providers.has(data.provider)||!states.has(data.status)||!Number.isFinite(Date.parse(data.expiresAt))||!Array.isArray(data.accounts)||data.accounts.length>200||(data.status!=='review'&&data.accounts.length))fail('SOCIAL_LINK_RESPONSE_INVALID',503)
      const accounts=data.accounts.map(a=>{const key=`${a?.platform}:${a?.externalId}`;if(!platformKey.test(key)||typeof a.displayName!=='string'||!a.displayName.trim()||a.displayName.length>300||(data.provider==='threads'?a.platform!=='threads':a.platform==='threads'))fail('SOCIAL_LINK_RESPONSE_INVALID',503);return {key,platform:a.platform,externalId:a.externalId,displayName:a.displayName}})
      if(new Set(accounts.map(a=>a.key)).size!==accounts.length)fail('SOCIAL_LINK_RESPONSE_INVALID',503)
      return {id:link,provider:data.provider,status:data.status,expiresAt:data.expiresAt,accounts,result:data.result==null?null:counts(data.result)}
    },
    async approve(req,linkId,keys){
      if(!Array.isArray(keys)||keys.length<1||keys.length>200||keys.some(k=>typeof k!=='string'||!platformKey.test(k))||new Set(keys).size!==keys.length)fail('SOCIAL_LINK_SELECTION_INVALID')
      const result=await call('social_oauth_link_approve_v7',{p_id:id(linkId),...identity(req),p_keys:keys})
      if(result===null)fail('SOCIAL_LINK_NOT_REVIEWABLE',409)
      return counts(result)
    },
    async cancel(req,linkId){if(await call('social_oauth_link_cancel_v7',{p_id:id(linkId),...identity(req)})!==true)fail('SOCIAL_LINK_NOT_CANCELLABLE',409);return {status:'cancelled'}},
    async cleanup(){const n=await call('social_oauth_link_cleanup_v7');if(!Number.isInteger(n)||n<0||n>100)fail('SOCIAL_LINK_RESPONSE_INVALID',503);return n}
  }
}
