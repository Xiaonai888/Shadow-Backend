import {SocialOAuthError} from './socialOAuthState.service.js'
import {oauthConnectionId} from './socialOAuthReconnect.service.js'
import {encryptSocialToken,decryptSocialToken} from './tokenVault.service.js'
const cipherValid=v=>typeof v==='string'&&v.length<=100000&&/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v)
export function createThreadsTokenMaintenance({db,threads,encryptToken=encryptSocialToken,decryptToken=decryptSocialToken,clock=Date.now,onError=()=>{}}={}){
  if(!db?.rpc||![threads?.refreshUserToken,threads?.verifyAccount,encryptToken,decryptToken,clock,onError].every(fn=>typeof fn==='function'))throw new TypeError('SOCIAL_THREADS_REFRESH_DEPENDENCIES')
  let running=false
  async function call(name,args){
    let result
    try{result=await db.rpc(name,args)}catch{throw new SocialOAuthError('SOCIAL_THREADS_REFRESH_DATABASE_FAILED',503)}
    if(result?.error)throw new SocialOAuthError('SOCIAL_THREADS_REFRESH_DATABASE_FAILED',503)
    return result?.data
  }
  const report=code=>{try{onError({code})}catch{}}
  async function finish(row,cipher,expires,reauth){
    const ok=await call('social_threads_refresh_finish_v4',{p_id:row.id,p_revision:row.updated_at,p_lease:row.oauth_refresh_after,p_cipher:cipher,p_expires:expires,p_reauth:reauth})
    if(typeof ok!=='boolean')throw new SocialOAuthError('SOCIAL_THREADS_REFRESH_RESPONSE_INVALID',503)
    return ok
  }
  return {async run(){
    if(running)return {state:'busy'}
    running=true
    try{
      const rows=await call('social_threads_refresh_claim_v4',{})
      if(!Array.isArray(rows)||rows.length>5)throw new SocialOAuthError('SOCIAL_THREADS_REFRESH_RESPONSE_INVALID',503)
      const result={state:'ok',claimed:rows.length,refreshed:0,reauth:0,stale:0,failed:0}
      for(const row of rows){
        try{
          const now=clock()
          if(!oauthConnectionId(row?.id)||typeof row.external_id!=='string'||!/^\d{1,40}$/.test(row.external_id)||!cipherValid(row.token_ciphertext)||!Number.isFinite(now)||!Number.isFinite(Date.parse(row.updated_at))||Date.parse(row.oauth_refresh_after)<=now||!Number.isFinite(Date.parse(row.oauth_refresh_after))||!Number.isFinite(Date.parse(row.token_expires_at))||Date.parse(row.token_expires_at)<=now)throw new SocialOAuthError('SOCIAL_THREADS_REFRESH_RESPONSE_INVALID',503)
          const binding={ownerType:'admin',ownerId:'shadow',platform:'threads',externalId:row.external_id}
          const token=decryptToken(row.token_ciphertext,binding)
          let next,account
          try{
            next=await threads.refreshUserToken(token)
            if(typeof next?.token!=='string'||!next.token||next.token.length>16384||/\s/.test(next.token)||!Number.isSafeInteger(next.expiresIn)||next.expiresIn<=0||next.expiresIn>31536000)throw new SocialOAuthError('SOCIAL_THREADS_TOKEN_RESPONSE_INVALID',502)
            account=await threads.verifyAccount(next.token,row.external_id)
          }catch(error){
            if(error?.code==='SOCIAL_THREADS_REAUTH_REQUIRED'){
              if(await finish(row,null,null,true))result.reauth++;else result.stale++
              continue
            }
            throw error
          }
          if(account?.externalId!==row.external_id)throw new SocialOAuthError('SOCIAL_THREADS_ACCOUNT_MISMATCH',403)
          const expires=new Date(clock()+next.expiresIn*1000).toISOString(),cipher=encryptToken(next.token,binding)
          if(!cipherValid(cipher)||cipher===next.token)throw new SocialOAuthError('SOCIAL_OAUTH_VAULT_UNAVAILABLE',503)
          if(await finish(row,cipher,expires,false))result.refreshed++;else result.stale++
        }catch{result.failed++;report('SOCIAL_THREADS_REFRESH_ACCOUNT_FAILED')}
      }
      return result
    }finally{running=false}
  }}
}
