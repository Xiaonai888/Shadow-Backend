import {createHash} from 'node:crypto'
import {SocialOAuthError} from './socialOAuthState.service.js'
import {oauthConnectionId} from './socialOAuthReconnect.service.js'
function context(req){
  if(req?.admin?.has_all_permissions!==true)throw new SocialOAuthError('SOCIAL_ADMIN_PERMISSION_REQUIRED',403)
  const actorId=req.admin.admin_id,bearer=req.headers?.authorization
  if(typeof actorId!=='string'||!actorId||actorId.length>128||typeof bearer!=='string'||!/^Bearer [^\s]+$/.test(bearer)||bearer.length>16400)throw new SocialOAuthError('SOCIAL_OAUTH_IDENTITY_INVALID',401)
  if(!req.body||typeof req.body!=='object'||Array.isArray(req.body))throw new SocialOAuthError('SOCIAL_OAUTH_INPUT_INVALID')
  const connectionId=oauthConnectionId(req.body.connectionId),sessionHash=createHash('sha256').update(bearer).digest('hex')
  return {connectionId,binding:{actorId,provider:'threads',sessionBinding:`${sessionHash}:${connectionId||'sync'}`}}
}
export function createThreadsOAuthAdmin({stateStore,threads,accountStore,reconnect}={}){
  if(![stateStore?.issue,stateStore?.consume,threads?.authorizationUrl,threads?.complete,accountStore?.importAdmin,reconnect?.target,reconnect?.reconnect].every(fn=>typeof fn==='function'))throw new TypeError('SOCIAL_THREADS_ADMIN_DEPENDENCIES')
  async function target(id){if(id&&(await reconnect.target(id))?.platform!=='threads')throw new SocialOAuthError('SOCIAL_OAUTH_CONNECTION_NOT_FOUND',404)}
  return {
    async start(req){
      const {connectionId,binding}=context(req)
      await target(connectionId)
      return {authorizationUrl:threads.authorizationUrl(await stateStore.issue(binding))}
    },
    async complete(req){
      const {connectionId,binding}=context(req),{state,code}=req.body
      if(typeof code!=='string'||!code||code.length>8192||/\s/.test(code))throw new SocialOAuthError('SOCIAL_OAUTH_CODE_INVALID')
      await stateStore.consume(binding,state)
      await target(connectionId)
      const account=await threads.complete(code)
      if(account?.platform!=='threads')throw new SocialOAuthError('SOCIAL_THREADS_ACCOUNT_MISMATCH',403)
      const result=connectionId?await reconnect.reconnect(connectionId,[account]):await accountStore.importAdmin([account])
      return {mode:connectionId?'reconnect':'sync',threadsFound:1,saved:result.saved,skipped:result.skipped,...(connectionId?{disabledRules:result.disabledRules,cancelledJobs:result.cancelledJobs}:{})}
    }
  }
}
