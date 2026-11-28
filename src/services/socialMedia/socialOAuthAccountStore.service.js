import {SocialOAuthError} from './socialOAuthState.service.js'
import {encryptSocialToken} from './tokenVault.service.js'

const idValid=v=>typeof v==='string'&&/^\d{1,40}$/.test(v)
const nameValid=v=>typeof v==='string'&&v.trim().length>0&&v.length<=300
const tokenValid=v=>typeof v==='string'&&v.length>0&&v.length<=16384&&!/\s/.test(v)
const ciphertextValid=v=>typeof v==='string'&&v.length<=100000&&/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v)
export function createSocialOAuthAccountStore({db,encryptToken=encryptSocialToken,clock=Date.now}={}){
  if(typeof db?.rpc!=='function'||typeof encryptToken!=='function'||typeof clock!=='function')throw new TypeError('SOCIAL_OAUTH_IMPORT_DEPENDENCIES')
  return {async importAdmin(accounts){
    if(!Array.isArray(accounts)||accounts.length>200)throw new SocialOAuthError('SOCIAL_OAUTH_IMPORT_INVALID')
    const now=clock(),seen=new Set(),rows=[]
    for(const account of accounts){
      const {platform,externalId,displayName,token,expiresAt=null}=account??{}
      const key=`${platform}:${externalId}`
      if(!['facebook','instagram','threads'].includes(platform)||!idValid(externalId)||!nameValid(displayName)||!tokenValid(token)||seen.has(key)||!Number.isFinite(now)||(['instagram','threads'].includes(platform)&&expiresAt===null)||(expiresAt!==null&&(typeof expiresAt!=='string'||!Number.isFinite(Date.parse(expiresAt))||Date.parse(expiresAt)<=now)))throw new SocialOAuthError('SOCIAL_OAUTH_IMPORT_INVALID')
      seen.add(key)
      let ciphertext
      try{ciphertext=encryptToken(token,{ownerType:'admin',ownerId:'shadow',platform,externalId})}catch{throw new SocialOAuthError('SOCIAL_OAUTH_VAULT_UNAVAILABLE',503)}
      if(!ciphertextValid(ciphertext)||ciphertext===token)throw new SocialOAuthError('SOCIAL_OAUTH_VAULT_UNAVAILABLE',503)
      rows.push({platform,external_id:externalId,display_name:displayName.trim(),token_ciphertext:ciphertext,token_expires_at:expiresAt})
    }
    if(!rows.length)return {saved:0,skipped:0}
    let result
    try{result=await db.rpc('social_oauth_import_admin_v2',{p_rows:rows})}catch{throw new SocialOAuthError('SOCIAL_OAUTH_IMPORT_DATABASE_FAILED',503)}
    const {saved,skipped}=result?.data??{}
    if(result?.error||!Number.isSafeInteger(saved)||saved<0||!Number.isSafeInteger(skipped)||skipped<0||saved+skipped!==rows.length)throw new SocialOAuthError('SOCIAL_OAUTH_IMPORT_DATABASE_FAILED',503)
    return {saved,skipped}
  }}
}
