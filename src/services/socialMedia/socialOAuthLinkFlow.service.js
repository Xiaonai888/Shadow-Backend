import {createSocialOAuthAdmin} from './socialOAuthAdmin.service.js'
import {createSocialOAuthAccountStore} from './socialOAuthAccountStore.service.js'
import {createFacebookOAuth,facebookOAuthConfig} from './facebookOAuth.service.js'
import {createFacebookOAuthGrants} from './facebookOAuthGrants.service.js'
import {createThreadsOAuth} from './threadsOAuth.service.js'
import {threadsGraphConfig} from './threadsGraphTransport.service.js'
import {SocialOAuthError} from './socialOAuthState.service.js'
const fail=(code,status=400)=>{throw new SocialOAuthError(code,status)}
const allowed=new Set(['facebook','threads'])
const statePattern=/^[A-Za-z0-9_-]{43}$/
export function socialOAuthLinkProviders(env=process.env){
  const callback=(value,path)=>{try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||u.pathname!==path||u.href!==value)throw new Error();return value}catch{fail('SOCIAL_LINK_CALLBACK_CONFIG_REQUIRED',503)}}
  const fbEnv=()=>({...env,SOCIAL_META_OAUTH_REDIRECT_URI:callback(env.SOCIAL_META_LINK_REDIRECT_URI,'/api/social-oauth/link/facebook')})
  const thEnv=()=>({...env,SOCIAL_THREADS_OAUTH_REDIRECT_URI:callback(env.SOCIAL_THREADS_LINK_REDIRECT_URI,'/api/social-oauth/link/threads')})
  return {
    facebook(){const e=fbEnv();facebookOAuthConfig(e);return {facebook:createFacebookOAuth({env:e}),grantedPermissions:createFacebookOAuthGrants({env:e})}},
    threads(){const e=thEnv();threadsGraphConfig(e);return {threads:createThreadsOAuth({env:e})}}
  }
}
export function createSocialOAuthLinkFlow({store,providers=socialOAuthLinkProviders(),clock=Date.now,encryptToken}={}){
  if(![store?.issue,store?.claim,store?.stage,store?.fail,providers?.facebook,providers?.threads,clock].every(fn=>typeof fn==='function'))throw new TypeError('SOCIAL_LINK_FLOW_DEPENDENCIES')
  function adapter(provider){if(!allowed.has(provider))fail('SOCIAL_OAUTH_PROVIDER_INVALID');return providers[provider]()}
  return {
    async start(req,provider){
      const a=adapter(provider),authorize=provider==='facebook'?a.facebook.authorizationUrl:a.threads.authorizationUrl
      authorize('a'.repeat(43))
      const {id,state}=await store.issue(req,provider)
      try{return {id,authorizationUrl:authorize(state),expiresInSeconds:900}}catch(error){try{await store.cancel(req,id)}catch{}throw error}
    },
    async callback(provider,{state,code,denied=false}={}){
      if(!allowed.has(provider)||typeof state!=='string'||!statePattern.test(state))fail('SOCIAL_LINK_STATE_INVALID')
      if(denied!==true&&(typeof code!=='string'||!code||code.length>8192||/\s/.test(code)))fail('SOCIAL_OAUTH_CODE_INVALID')
      const linkId=await store.claim(provider,state)
      try{
        if(denied===true){await store.fail(linkId);return {status:'failed'}}
        const a=adapter(provider)
        let staged=false
        const accountStore=createSocialOAuthAccountStore({clock,encryptToken,db:{async rpc(name,args){
          if(name!=='social_oauth_import_admin_v2'||staged)fail('SOCIAL_LINK_STAGE_INVALID',503)
          await store.stage(linkId,args.p_rows)
          staged=true
          return {data:{saved:args.p_rows.length,skipped:0}}
        }}})
        if(provider==='facebook'){
          const context={provider:'facebook',actorId:'cross-browser',sessionBinding:linkId}
          const service=createSocialOAuthAdmin({clock,facebook:a.facebook,grantedPermissions:a.grantedPermissions,accountStore,stateStore:{issue:async()=>fail('SOCIAL_LINK_STAGE_INVALID',503),consume:async(c,s)=>{if(c!==context||s!==state)fail('SOCIAL_LINK_STATE_INVALID');return true}}})
          await service.complete(context,{state,code})
        }else{
          const account=await a.threads.complete(code)
          if(account?.platform!=='threads')fail('SOCIAL_THREADS_ACCOUNT_MISMATCH',403)
          await accountStore.importAdmin([account])
        }
        if(!staged)fail('SOCIAL_LINK_NO_ACCOUNTS',422)
        return {status:'review'}
      }catch(error){try{await store.fail(linkId)}catch{}throw error}
    }
  }
}
