import {createHash} from 'node:crypto'
import {SocialOAuthError} from './socialOAuthState.service.js'
import {oauthConnectionId} from './socialOAuthReconnect.service.js'
import {createSocialOAuthAdmin} from './socialOAuthAdmin.service.js'

function requestContext(req){
  if(req?.admin?.has_all_permissions!==true)throw new SocialOAuthError('SOCIAL_ADMIN_PERMISSION_REQUIRED',403)
  const actorId=req.admin.admin_id
  const bearer=req.headers?.authorization
  if(typeof actorId!=='string'||!actorId||actorId.length>128||typeof bearer!=='string'||!/^Bearer [^\s]+$/.test(bearer)||bearer.length>16400)throw new SocialOAuthError('SOCIAL_OAUTH_IDENTITY_INVALID',401)
  if(!req.body||typeof req.body!=='object'||Array.isArray(req.body))throw new SocialOAuthError('SOCIAL_OAUTH_INPUT_INVALID')
  const connectionId=oauthConnectionId(req.body.connectionId)
  const sessionHash=createHash('sha256').update(bearer).digest('hex')
  return {connectionId,context:{actorId,sessionBinding:`${sessionHash}:${connectionId||'sync'}`,provider:'facebook'}}
}
export function createSocialOAuthAdminFlow({stateStore,facebook,grantedPermissions,accountStore,reconnect,clock=Date.now}={}){
  if(!reconnect?.target||!reconnect?.reconnect)throw new TypeError('SOCIAL_OAUTH_FLOW_DEPENDENCIES')
  const base={stateStore,facebook,grantedPermissions,accountStore,clock}
  const sync=createSocialOAuthAdmin(base)
  return {
    async start(req){
      const {connectionId,context}=requestContext(req)
      if(connectionId)await reconnect.target(connectionId)
      return sync.start(context)
    },
    async complete(req){
      const {connectionId,context}=requestContext(req)
      const {state,code}=req.body
      let details=null
      const service=connectionId?createSocialOAuthAdmin({...base,accountStore:{async importAdmin(accounts){details=await reconnect.reconnect(connectionId,accounts);return details}}}):sync
      const result=await service.complete(context,{state,code})
      return connectionId?{...result,mode:'reconnect',disabledRules:details.disabledRules,cancelledJobs:details.cancelledJobs}:{...result,mode:'sync'}
    }
  }
}
export function createSocialOAuthAdminHandlers(flow,{onError=()=>{}}={}){
  if(!flow?.start||!flow?.complete)throw new TypeError('SOCIAL_OAUTH_FLOW_REQUIRED')
  const wrap=fn=>async(req,res)=>{
    try{return res.json({ok:true,...await fn(req)})}
    catch(error){
      const known=error instanceof SocialOAuthError&&/^SOCIAL_[A-Z0-9_]{1,90}$/.test(error.code||'')&&Number.isInteger(error.status)&&error.status>=400&&error.status<=599
      const code=known?error.code:'SOCIAL_OAUTH_REQUEST_FAILED',status=known?error.status:500
      if(status>=500)try{onError(code)}catch{}
      return res.status(status).json({ok:false,code,message:code})
    }
  }
  return {start:wrap(flow.start),complete:wrap(flow.complete)}
}
