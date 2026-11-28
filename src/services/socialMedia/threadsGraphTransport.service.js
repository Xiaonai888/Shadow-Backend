import {SocialOAuthError} from './socialOAuthState.service.js'

export const threadsId=v=>typeof v==='string'&&/^\d{1,40}$/.test(v)
export const threadsToken=v=>typeof v==='string'&&v.length>0&&v.length<=16384&&!/\s/.test(v)
export class ThreadsGraphError extends SocialOAuthError{
  constructor(code,status=502,uncertain=false){super(code,status);this.uncertain=uncertain}
}
export function threadsGraphConfig(env=process.env){
  const appId=env.SOCIAL_THREADS_APP_ID,secret=env.SOCIAL_THREADS_APP_SECRET,redirectUri=env.SOCIAL_THREADS_OAUTH_REDIRECT_URI,version=env.SOCIAL_THREADS_GRAPH_VERSION||'v1.0'
  try{
    if(!threadsId(appId)||typeof secret!=='string'||!secret.trim()||secret.length>1024||!/^v[1-9]\d*\.\d+$/.test(version))throw new Error()
    const u=new URL(redirectUri)
    if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||u.pathname==='/'||u.href!==redirectUri)throw new Error()
  }catch{throw new ThreadsGraphError('SOCIAL_THREADS_CONFIG_REQUIRED',503)}
  return {appId,secret,redirectUri,version}
}
export function createThreadsGraph({env=process.env,fetchImpl=globalThis.fetch}={}){
  if(typeof fetchImpl!=='function')throw new TypeError('SOCIAL_THREADS_FETCH_REQUIRED')
  return async function request({path,method='GET',params={},token,authEndpoint=false,publishing=false}={}){
    const {version}=threadsGraphConfig(env)
    const authPaths={'oauth/access_token':'POST','access_token':'GET','refresh_access_token':'GET','debug_token':'GET'}
    if(authEndpoint?authPaths[path]!==method:!(/^(?:me|\d{1,40})(?:\/(?:threads|threads_publish))?$/.test(path)&&['GET','POST'].includes(method)))throw new ThreadsGraphError('SOCIAL_THREADS_PATH_INVALID',400)
    if(!params||Object.hasOwn(params,'access_token')||token!==undefined&&!threadsToken(token))throw new ThreadsGraphError('SOCIAL_THREADS_REQUEST_INVALID',400)
    const url=new URL(`https://graph.threads.net/${authEndpoint?'':version+'/'}${path}`)
    const headers={Accept:'application/json'}
    if(token)headers.Authorization=`Bearer ${token}`
    const form=new URLSearchParams(params)
    const options={method,headers,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)}
    if(method==='POST'){headers['Content-Type']='application/x-www-form-urlencoded';options.body=form}else url.search=form.toString()
    let response,data
    try{response=await fetchImpl(url,options);data=await response.json()}catch{throw new ThreadsGraphError('SOCIAL_THREADS_NETWORK_FAILED',502,publishing)}
    if(!response.ok||!data||data.error){
      if(data?.error?.code===190)throw new ThreadsGraphError('SOCIAL_THREADS_REAUTH_REQUIRED',401,publishing)
      throw new ThreadsGraphError('SOCIAL_THREADS_API_REJECTED',502,publishing)
    }
    return data
  }
}
