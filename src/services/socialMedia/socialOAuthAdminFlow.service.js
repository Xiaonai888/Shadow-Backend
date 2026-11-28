import {createHash} from 'node:crypto'
import {SocialOAuthError} from './socialOAuthState.service.js'
import {oauthConnectionId} from './socialOAuthReconnect.service.js'
import {createSocialOAuthAdmin} from './socialOAuthAdmin.service.js'

export function verifiedSocialOAuthContext(req,provider){
  if(req?.admin?.has_all_permissions!==true)throw new SocialOAuthError('SOCIAL_ADMIN_PERMISSION_REQUIRED',403)
  if(!['facebook','threads'].includes(provider))throw new SocialOAuthError('SOCIAL_OAUTH_PROVIDER_INVALID')
  const actorId=req.admin.admin_id
  const bearer=req.headers?.authorization
  const sessionId=req.admin.session?.id,deviceId=req.admin.device?.id
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if(typeof sessionId!=='string'||!uuid.test(sessionId)||typeof deviceId!=='string'||!uuid.test(deviceId))throw new SocialOAuthError('SOCIAL_OAUTH_IDENTITY_INVALID',401)
  if(typeof actorId!=='string'||!actorId||actorId.length>128||typeof bearer!=='string'||!/^Bearer [^\s]+$/.test(bearer)||bearer.length>16400)throw new SocialOAuthError('SOCIAL_OAUTH_IDENTITY_INVALID',401)
  if(!req.body||typeof req.body!=='object'||Array.isArray(req.body))throw new SocialOAuthError('SOCIAL_OAUTH_INPUT_INVALID')
  const connectionId=oauthConnectionId(req.body.connectionId)
  const sessionHash=createHash('sha256').update(JSON.stringify([sessionId.toLowerCase(),deviceId.toLowerCase()])).digest('hex')
  return {connectionId,context:{actorId,sessionBinding:`${sessionHash}:${connectionId||'sync'}`,provider}}
}
export function createSocialOAuthAdminFlow({stateStore,facebook,grantedPermissions,accountStore,reconnect,clock=Date.now}={}){
  if(!reconnect?.target||!reconnect?.reconnect)throw new TypeError('SOCIAL_OAUTH_FLOW_DEPENDENCIES')
  const base={stateStore,facebook,grantedPermissions,accountStore,clock}
  const sync=createSocialOAuthAdmin(base)
  return {
    async start(req){
      const {connectionId,context}=verifiedSocialOAuthContext(req,'facebook')
      if(connectionId&&(await reconnect.target(connectionId))?.platform==='threads')throw new SocialOAuthError('SOCIAL_OAUTH_CONNECTION_NOT_FOUND',404)
      return sync.start(context)
    },
    async complete(req){
      const {connectionId,context}=verifiedSocialOAuthContext(req,'facebook')
      const {state,code}=req.body
      let details=null
      const service=connectionId?createSocialOAuthAdmin({...base,accountStore:{async importAdmin(accounts){details=await reconnect.reconnect(connectionId,accounts);return details}}}):sync
      const result=await service.complete(context,{state,code})
      return connectionId?{...result,mode:'reconnect',disabledRules:details.disabledRules,cancelledJobs:details.cancelledJobs}:{...result,mode:'sync'}
    }
  }
}
export function wrapSocialOAuthAdminOperation(fn,{onError=()=>{}}={}){
  if(typeof fn!=='function')throw new TypeError('SOCIAL_OAUTH_OPERATION_REQUIRED')
  return async(req,res)=>{
    try{return res.json({ok:true,...await fn(req)})}
    catch(error){
      const known=error instanceof SocialOAuthError&&/^SOCIAL_[A-Z0-9_]{1,90}$/.test(error.code||'')&&Number.isInteger(error.status)&&error.status>=400&&error.status<=599
      const code=known?error.code:'SOCIAL_OAUTH_REQUEST_FAILED',status=known?error.status:500
      if(status>=500)try{onError(code)}catch{}
      return res.status(status).json({ok:false,code,message:code})
    }
  }
}
export function createSocialOAuthAdminHandlers(flow,options={}){
  if(!flow?.start||!flow?.complete)throw new TypeError('SOCIAL_OAUTH_FLOW_REQUIRED')
  return {start:wrapSocialOAuthAdminOperation(flow.start,options),complete:wrapSocialOAuthAdminOperation(flow.complete,options)}
}
