const storageKey='shadow_social_oauth_pending_v1'
const statePattern=/^[A-Za-z0-9_-]{43}$/
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const providers=new Set(['facebook','threads'])
export const oauthCallbackPath=provider=>provider==='threads'?'/social-oauth/threads':'/social-oauth/callback'
export function prepareSocialOAuth({provider,connectionId=null,authorizationUrl,origin,storage,now=Date.now()}={}){
  if(!providers.has(provider)||connectionId!==null&&(typeof connectionId!=='string'||!uuidPattern.test(connectionId))||!Number.isFinite(now))throw new Error('SOCIAL_OAUTH_INPUT_INVALID')
  let url
  try{url=new URL(authorizationUrl)}catch{throw new Error('SOCIAL_OAUTH_REDIRECT_INVALID')}
  const allowed=provider==='facebook'?url.origin==='https://www.facebook.com'&&/^\/v\d+\.\d+\/dialog\/oauth$/.test(url.pathname):['https://threads.net','https://www.threads.net','https://threads.com','https://www.threads.com'].includes(url.origin)&&url.pathname==='/oauth/authorize'
  const state=url.searchParams.get('state')
  if(!allowed||url.username||url.password||url.hash||url.searchParams.getAll('state').length!==1||!statePattern.test(state||'')||url.searchParams.getAll('redirect_uri').length!==1||url.searchParams.get('redirect_uri')!==origin+oauthCallbackPath(provider))throw new Error('SOCIAL_OAUTH_REDIRECT_INVALID')
  storage.setItem(storageKey,JSON.stringify({provider,connectionId,state,createdAt:now}))
  return url.href
}
export function consumeSocialOAuth({provider,search,storage,now=Date.now()}={}){
  if(!providers.has(provider))throw new Error('SOCIAL_OAUTH_INPUT_INVALID')
  let pending
  try{pending=JSON.parse(storage.getItem(storageKey)||'null')}catch{pending=null}
  const params=new URLSearchParams(search),state=params.get('state'),code=params.get('code')
  if(!pending||pending.provider!==provider||!statePattern.test(state||'')||params.getAll('state').length!==1||state!==pending.state||!Number.isFinite(now)||!Number.isFinite(pending.createdAt)||now<pending.createdAt||now-pending.createdAt>600000||(pending.connectionId!==null&&(typeof pending.connectionId!=='string'||!uuidPattern.test(pending.connectionId))))throw new Error('SOCIAL_OAUTH_STATE_INVALID')
  storage.removeItem(storageKey)
  if(params.has('error')||params.has('error_code'))throw new Error('SOCIAL_OAUTH_CANCELLED')
  if(params.getAll('code').length!==1||typeof code!=='string'||!code||code.length>8192||/\s/.test(code))throw new Error('SOCIAL_OAUTH_CODE_INVALID')
  return {state,code,connectionId:pending.connectionId}
}
