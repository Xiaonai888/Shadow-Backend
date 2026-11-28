import {SocialOAuthError} from './socialOAuthState.service.js'
import {verifiedSocialOAuthContext} from './socialOAuthAdminFlow.service.js'
export function createThreadsOAuthAdmin({stateStore,threads,accountStore,reconnect}={}){
  if(![stateStore?.issue,stateStore?.consume,threads?.authorizationUrl,threads?.complete,accountStore?.importAdmin,reconnect?.target,reconnect?.reconnect].every(fn=>typeof fn==='function'))throw new TypeError('SOCIAL_THREADS_ADMIN_DEPENDENCIES')
  async function target(id){if(id&&(await reconnect.target(id))?.platform!=='threads')throw new SocialOAuthError('SOCIAL_OAUTH_CONNECTION_NOT_FOUND',404)}
  return {
    async start(req){
      const {connectionId,context:binding}=verifiedSocialOAuthContext(req,'threads')
      await target(connectionId)
      return {authorizationUrl:threads.authorizationUrl(await stateStore.issue(binding))}
    },
    async complete(req){
      const {connectionId,context:binding}=verifiedSocialOAuthContext(req,'threads'),{state,code}=req.body
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
