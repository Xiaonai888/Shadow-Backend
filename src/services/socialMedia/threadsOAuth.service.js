import {createThreadsGraph,threadsGraphConfig,threadsId,threadsToken,ThreadsGraphError} from './threadsGraphTransport.service.js'

const scopes=['threads_basic','threads_content_publish']
const fail=(code,status=502)=>{throw new ThreadsGraphError(code,status)}
function longToken(data){
  if(!threadsToken(data?.access_token)||!Number.isSafeInteger(data.expires_in)||data.expires_in<=0||data.expires_in>31536000)fail('SOCIAL_THREADS_TOKEN_RESPONSE_INVALID')
  return {token:data.access_token,expiresIn:data.expires_in}
}
export function createThreadsOAuth({env=process.env,fetchImpl=globalThis.fetch,clock=Date.now}={}){
  const request=createThreadsGraph({env,fetchImpl})
  return {
    authorizationUrl(state){
      if(typeof state!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(state))fail('SOCIAL_OAUTH_STATE_INVALID',400)
      const {appId,redirectUri}=threadsGraphConfig(env),u=new URL('https://threads.net/oauth/authorize')
      u.search=new URLSearchParams({client_id:appId,redirect_uri:redirectUri,scope:scopes.join(','),response_type:'code',state}).toString()
      return u.href
    },
    async exchangeCode(code){
      if(typeof code!=='string'||!code||code.length>8192||/\s/.test(code))fail('SOCIAL_OAUTH_CODE_INVALID',400)
      const {appId,secret,redirectUri}=threadsGraphConfig(env)
      const data=await request({path:'oauth/access_token',method:'POST',authEndpoint:true,params:{client_id:appId,client_secret:secret,grant_type:'authorization_code',redirect_uri:redirectUri,code}})
      if(!threadsToken(data?.access_token)||!threadsId(String(data?.user_id??''))||(typeof data.user_id==='number'&&!Number.isSafeInteger(data.user_id)))fail('SOCIAL_THREADS_TOKEN_RESPONSE_INVALID')
      return {token:data.access_token,userId:String(data.user_id)}
    },
    async extendUserToken(token){
      if(!threadsToken(token))fail('SOCIAL_THREADS_TOKEN_INVALID',400)
      const {secret}=threadsGraphConfig(env)
      return longToken(await request({path:'access_token',authEndpoint:true,token,params:{grant_type:'th_exchange_token',client_secret:secret}}))
    },
    async refreshUserToken(token){
      if(!threadsToken(token))fail('SOCIAL_THREADS_TOKEN_INVALID',400)
      return longToken(await request({path:'refresh_access_token',authEndpoint:true,token,params:{grant_type:'th_refresh_token'}}))
    },
    async verifyAccount(token,expectedId){
      if(!threadsToken(token)||!threadsId(expectedId))fail('SOCIAL_THREADS_ACCOUNT_INVALID',400)
      const {appId,secret}=threadsGraphConfig(env)
      const debug=await request({path:'debug_token',authEndpoint:true,token:`TH|${appId}|${secret}`,params:{input_token:token}})
      const d=debug?.data
      if(d?.is_valid!==true||String(d.app_id)!==appId||String(d.user_id)!==expectedId||!Array.isArray(d.scopes)||!scopes.every(s=>d.scopes.includes(s)))fail('SOCIAL_THREADS_PERMISSIONS_REQUIRED',403)
      const profile=await request({path:'me',token,params:{fields:'id,username'}})
      if(profile?.id!==expectedId||typeof profile.username!=='string'||!profile.username.trim()||profile.username.length>300)fail('SOCIAL_THREADS_ACCOUNT_MISMATCH',403)
      return {externalId:profile.id,displayName:profile.username.trim()}
    },
    async complete(code){
      const initial=await this.exchangeCode(code)
      const extended=await this.extendUserToken(initial.token)
      const identity=await this.verifyAccount(extended.token,initial.userId)
      const now=clock()
      if(!Number.isFinite(now))fail('SOCIAL_OAUTH_CLOCK_INVALID',503)
      return {platform:'threads',...identity,token:extended.token,expiresAt:new Date(now+extended.expiresIn*1000).toISOString()}
    }
  }
}
