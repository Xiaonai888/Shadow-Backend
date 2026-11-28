import {createHash,randomBytes} from 'node:crypto'

const providers=new Set(['facebook','threads'])
const digest=value=>createHash('sha256').update(value).digest('hex')
const statePattern=/^[A-Za-z0-9_-]{43}$/
export class SocialOAuthError extends Error{
  constructor(code,status=400){super(code);this.code=code;this.status=status}
}
function identity({actorId,sessionBinding,provider}={}){
  if(typeof actorId!=='string'||!actorId||actorId.length>128||typeof sessionBinding!=='string'||!sessionBinding||sessionBinding.length>16384||!providers.has(provider))throw new SocialOAuthError('SOCIAL_OAUTH_IDENTITY_INVALID')
  return {p_actor_id:actorId,p_session_hash:digest(sessionBinding),p_provider:provider}
}
export function createSocialOAuthStateStore(db){
  if(typeof db?.rpc!=='function')throw new TypeError('SOCIAL_OAUTH_DB_REQUIRED')
  async function call(name,args){
    let result
    try{result=await db.rpc(name,args)}catch{throw new SocialOAuthError('SOCIAL_OAUTH_STATE_DATABASE_FAILED',503)}
    if(result?.error||typeof result?.data!=='boolean')throw new SocialOAuthError('SOCIAL_OAUTH_STATE_DATABASE_FAILED',503)
    return result.data
  }
  return {
    async issue(context){
      const args=identity(context),state=randomBytes(32).toString('base64url')
      if(!await call('social_oauth_state_issue_v1',{...args,p_state_hash:digest(state)}))throw new SocialOAuthError('SOCIAL_OAUTH_STATE_LIMIT',429)
      return state
    },
    async consume(context,state){
      const args=identity(context)
      if(typeof state!=='string'||!statePattern.test(state))throw new SocialOAuthError('SOCIAL_OAUTH_STATE_INVALID')
      if(!await call('social_oauth_state_consume_v1',{...args,p_state_hash:digest(state)}))throw new SocialOAuthError('SOCIAL_OAUTH_STATE_INVALID')
      return true
    }
  }
}
