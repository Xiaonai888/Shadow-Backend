import {SocialOAuthError} from './socialOAuthState.service.js'
import {encryptSocialToken} from './tokenVault.service.js'

const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const metaId=v=>typeof v==='string'&&/^\d{1,40}$/.test(v)
export function oauthConnectionId(value){
  if(value===null||value===undefined)return null
  if(typeof value!=='string'||!uuidPattern.test(value))throw new SocialOAuthError('SOCIAL_OAUTH_CONNECTION_INVALID')
  return value.toLowerCase()
}
export function createSocialOAuthReconnect({db,encryptToken=encryptSocialToken,clock=Date.now}={}){
  if(!db?.from||!db?.rpc||typeof encryptToken!=='function'||typeof clock!=='function')throw new TypeError('SOCIAL_OAUTH_RECONNECT_DEPENDENCIES')
  async function target(id){
    id=oauthConnectionId(id)
    if(!id)throw new SocialOAuthError('SOCIAL_OAUTH_CONNECTION_INVALID')
    let result
    try{result=await db.from('social_media_connections').select('id,platform,external_id').eq('owner_type','admin').eq('owner_id','shadow').eq('id',id).maybeSingle()}catch{throw new SocialOAuthError('SOCIAL_OAUTH_RECONNECT_DATABASE_FAILED',503)}
    if(result?.error)throw new SocialOAuthError('SOCIAL_OAUTH_RECONNECT_DATABASE_FAILED',503)
    const row=result?.data
    if(!row||row.id!==id||!['facebook','instagram','threads'].includes(row.platform)||!metaId(row.external_id))throw new SocialOAuthError('SOCIAL_OAUTH_CONNECTION_NOT_FOUND',404)
    return row
  }
  return {target,async reconnect(id,accounts){
    const row=await target(id)
    if(!Array.isArray(accounts)||accounts.length>200)throw new SocialOAuthError('SOCIAL_OAUTH_RECONNECT_INVALID')
    const matched=accounts.filter(a=>a?.platform===row.platform&&a.externalId===row.external_id)
    if(matched.length!==1)throw new SocialOAuthError('SOCIAL_OAUTH_RECONNECT_ACCOUNT_NOT_GRANTED',403)
    const {platform,externalId,displayName,token,expiresAt=null}=matched[0]
    const now=clock()
    if(typeof displayName!=='string'||!displayName.trim()||displayName.length>300||typeof token!=='string'||!token||token.length>16384||/\s/.test(token)||!Number.isFinite(now)||(['instagram','threads'].includes(platform)&&expiresAt===null)||(expiresAt!==null&&(typeof expiresAt!=='string'||!Number.isFinite(Date.parse(expiresAt))||Date.parse(expiresAt)<=now)))throw new SocialOAuthError('SOCIAL_OAUTH_RECONNECT_INVALID')
    let cipher
    try{cipher=encryptToken(token,{ownerType:'admin',ownerId:'shadow',platform,externalId})}catch{throw new SocialOAuthError('SOCIAL_OAUTH_VAULT_UNAVAILABLE',503)}
    if(typeof cipher!=='string'||cipher===token||cipher.length>100000||!/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cipher))throw new SocialOAuthError('SOCIAL_OAUTH_VAULT_UNAVAILABLE',503)
    let result
    try{result=await db.rpc('social_oauth_reconnect_admin_v3',{p_id:row.id,p_platform:platform,p_external_id:externalId,p_display_name:displayName.trim(),p_token_ciphertext:cipher,p_token_expires_at:expiresAt})}catch{throw new SocialOAuthError('SOCIAL_OAUTH_RECONNECT_DATABASE_FAILED',503)}
    if(result?.error)throw new SocialOAuthError('SOCIAL_OAUTH_RECONNECT_DATABASE_FAILED',503)
    const data=result?.data
    if(data?.state==='not_found')throw new SocialOAuthError('SOCIAL_OAUTH_CONNECTION_NOT_FOUND',404)
    if(data?.state!=='connected'||![data.disabledRules,data.cancelledJobs].every(n=>Number.isSafeInteger(n)&&n>=0))throw new SocialOAuthError('SOCIAL_OAUTH_RECONNECT_DATABASE_FAILED',503)
    return {saved:1,skipped:accounts.length-1,disabledRules:data.disabledRules,cancelledJobs:data.cancelledJobs}
  }}
}
