import {createHmac} from 'node:crypto'
import {facebookOAuthConfig} from './facebookOAuth.service.js'
import {SocialOAuthError} from './socialOAuthState.service.js'

const facebookScopes=['pages_show_list','pages_manage_posts','pages_read_engagement']
const instagramScopes=['instagram_basic','instagram_content_publish']
export function createFacebookOAuthGrants({env=process.env,fetchImpl=globalThis.fetch}={}){
  if(typeof fetchImpl!=='function')throw new TypeError('SOCIAL_OAUTH_FETCH_REQUIRED')
  return async function granted(token){
    if(typeof token!=='string'||!token||token.length>16384||/\s/.test(token))throw new SocialOAuthError('SOCIAL_OAUTH_TOKEN_INVALID')
    const {version,secret}=facebookOAuthConfig(env)
    const url=new URL(`https://graph.facebook.com/${version}/me/permissions`)
    url.search=new URLSearchParams({limit:'100',appsecret_proof:createHmac('sha256',secret).update(token).digest('hex')}).toString()
    let response,data
    try{response=await fetchImpl(url,{method:'GET',headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});data=await response.json()}catch{throw new SocialOAuthError('SOCIAL_OAUTH_GRANTS_UNAVAILABLE',502)}
    if(!response.ok||data?.error||!Array.isArray(data?.data)||data.data.length>100||data.paging?.next||data.data.some(x=>typeof x?.permission!=='string'||typeof x?.status!=='string'))throw new SocialOAuthError('SOCIAL_OAUTH_GRANTS_INVALID',502)
    const permissions=new Set(data.data.filter(x=>x.status==='granted').map(x=>x.permission))
    return {facebook:facebookScopes.every(x=>permissions.has(x)),instagram:instagramScopes.every(x=>permissions.has(x))&&facebookScopes.filter(x=>x!=='pages_manage_posts').every(x=>permissions.has(x))}
  }
}
