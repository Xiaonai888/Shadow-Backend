import {createHmac} from 'node:crypto'
import {SocialOAuthError} from './socialOAuthState.service.js'

const idPattern=/^\d{1,40}$/
const statePattern=/^[A-Za-z0-9_-]{43}$/
const tokenValid=v=>typeof v==='string'&&v.length>0&&v.length<=16384&&!/\s/.test(v)
const idValid=v=>typeof v==='string'&&idPattern.test(v)
export function facebookOAuthConfig(env=process.env){
  const appId=env.SOCIAL_META_APP_ID,secret=env.SOCIAL_META_APP_SECRET,version=env.SOCIAL_META_GRAPH_VERSION,configId=env.SOCIAL_META_LOGIN_CONFIG_ID,redirectUri=env.SOCIAL_META_OAUTH_REDIRECT_URI
  try{
    if(!idValid(appId)||!idValid(configId)||typeof secret!=='string'||!secret.trim()||secret.length>1024||!/^v[1-9]\d*\.\d+$/.test(version||''))throw new Error()
    const url=new URL(redirectUri)
    if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||url.pathname==='/'||url.href!==redirectUri)throw new Error()
  }catch{throw new SocialOAuthError('SOCIAL_OAUTH_META_CONFIG_REQUIRED',503)}
  return {appId,secret,version,configId,redirectUri}
}
export function createFacebookOAuth({env=process.env,fetchImpl=globalThis.fetch}={}){
  if(typeof fetchImpl!=='function')throw new TypeError('SOCIAL_OAUTH_FETCH_REQUIRED')
  async function get(path,params,token){
    const c=facebookOAuthConfig(env)
    const url=new URL(`https://graph.facebook.com/${c.version}/${path}`)
    const headers={Accept:'application/json'}
    if(token){
      if(!tokenValid(token))throw new SocialOAuthError('SOCIAL_OAUTH_TOKEN_INVALID')
      headers.Authorization=`Bearer ${token}`
      params={...params,appsecret_proof:createHmac('sha256',c.secret).update(token).digest('hex')}
    }
    url.search=new URLSearchParams(params).toString()
    let response,data
    try{response=await fetchImpl(url,{method:'GET',headers,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});data=await response.json()}catch{throw new SocialOAuthError('SOCIAL_OAUTH_META_UNAVAILABLE',502)}
    if(!response.ok||!data||data.error)throw new SocialOAuthError('SOCIAL_OAUTH_META_REJECTED',422)
    return data
  }
  function tokenResult(data){
    if(!tokenValid(data?.access_token)||!Number.isSafeInteger(data?.expires_in)||data.expires_in<=0)throw new SocialOAuthError('SOCIAL_OAUTH_TOKEN_RESPONSE_INVALID',502)
    return {token:data.access_token,expiresIn:data.expires_in}
  }
  return {
    authorizationUrl(state){
      if(typeof state!=='string'||!statePattern.test(state))throw new SocialOAuthError('SOCIAL_OAUTH_STATE_INVALID')
      const c=facebookOAuthConfig(env),url=new URL(`https://www.facebook.com/${c.version}/dialog/oauth`)
      url.search=new URLSearchParams({client_id:c.appId,redirect_uri:c.redirectUri,config_id:c.configId,state,response_type:'code',override_default_response_type:'true'}).toString()
      return url.href
    },
    async exchangeCode(code){
      if(typeof code!=='string'||!code||code.length>8192||/\s/.test(code))throw new SocialOAuthError('SOCIAL_OAUTH_CODE_INVALID')
      const c=facebookOAuthConfig(env)
      return tokenResult(await get('oauth/access_token',{client_id:c.appId,client_secret:c.secret,redirect_uri:c.redirectUri,code}))
    },
    async extendUserToken(token){
      if(!tokenValid(token))throw new SocialOAuthError('SOCIAL_OAUTH_TOKEN_INVALID')
      const c=facebookOAuthConfig(env)
      return tokenResult(await get('oauth/access_token',{grant_type:'fb_exchange_token',client_id:c.appId,client_secret:c.secret,fb_exchange_token:token}))
    },
    async accountPage(token,after=null){
      if(!tokenValid(token)||after!==null&&(typeof after!=='string'||!after||after.length>4096||/\s/.test(after)))throw new SocialOAuthError('SOCIAL_OAUTH_ACCOUNT_QUERY_INVALID')
      const params={fields:'id,name,access_token,tasks,instagram_business_account{id,username}',limit:'25',...(after?{after}:{})}
      const data=await get('me/accounts',params,token)
      if(!Array.isArray(data?.data)||data.data.length>25)throw new SocialOAuthError('SOCIAL_OAUTH_ACCOUNT_RESPONSE_INVALID',502)
      const pages=data.data.map(row=>{
        if(!idValid(row?.id)||typeof row.name!=='string'||!row.name.trim()||row.name.length>300||!tokenValid(row.access_token)||!Array.isArray(row.tasks)||row.tasks.some(x=>typeof x!=='string'))throw new SocialOAuthError('SOCIAL_OAUTH_ACCOUNT_RESPONSE_INVALID',502)
        const ig=row.instagram_business_account
        if(ig!=null&&(!idValid(ig.id)||typeof ig.username!=='string'||!ig.username.trim()||ig.username.length>300))throw new SocialOAuthError('SOCIAL_OAUTH_ACCOUNT_RESPONSE_INVALID',502)
        return {pageId:row.id,displayName:row.name,pageToken:row.access_token,tasks:row.tasks,instagram:ig?{id:ig.id,username:ig.username}:null}
      })
      const next=data.paging?.next?data.paging?.cursors?.after:null
      if(next!==null&&(typeof next!=='string'||!next||next.length>4096||/\s/.test(next)||next===after))throw new SocialOAuthError('SOCIAL_OAUTH_ACCOUNT_CURSOR_INVALID',502)
      return {pages,after:next}
    }
  }
}
