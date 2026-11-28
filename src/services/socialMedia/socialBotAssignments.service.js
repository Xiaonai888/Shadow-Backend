import {SocialOAuthError} from './socialOAuthState.service.js'
import {oauthConnectionId} from './socialOAuthReconnect.service.js'
const bots=new Set(['promotion','event'])
const validId=value=>{const id=oauthConnectionId(value);if(!id)throw new SocialOAuthError('SOCIAL_OAUTH_CONNECTION_INVALID');return id}
export function createSocialBotAssignments(db){
  if(!db?.rpc)throw new TypeError('SOCIAL_BOT_DB_REQUIRED')
  async function call(name,args){
    let result
    try{result=await db.rpc(name,args)}catch{throw new SocialOAuthError('SOCIAL_BOT_DATABASE_FAILED',503)}
    if(result?.error)throw new SocialOAuthError('SOCIAL_BOT_DATABASE_FAILED',503)
    return result?.data
  }
  return {
    async list(connectionIds){
      if(!Array.isArray(connectionIds)||connectionIds.length>10)throw new SocialOAuthError('SOCIAL_BOT_LIST_INVALID')
      const ids=[...new Set(connectionIds.map(validId))]
      if(!ids.length)return []
      const rows=await call('social_oauth_bot_list_v4',{p_ids:ids})
      if(!Array.isArray(rows)||rows.length>ids.length*2||rows.some(r=>!ids.includes(r?.connectionId)||!bots.has(r.bot))||new Set(rows.map(r=>`${r.connectionId}:${r.bot}`)).size!==rows.length)throw new SocialOAuthError('SOCIAL_BOT_RESPONSE_INVALID',503)
      return rows.map(({connectionId,bot})=>({connectionId,bot}))
    },
    async set(connectionId,bot,assigned){
      const id=validId(connectionId)
      if(!bots.has(bot)||typeof assigned!=='boolean')throw new SocialOAuthError('SOCIAL_BOT_ASSIGNMENT_INVALID')
      const data=await call('social_oauth_assign_bot_v4',{p_id:id,p_bot:bot,p_assigned:assigned})
      if(data?.state==='not_found')throw new SocialOAuthError('SOCIAL_OAUTH_CONNECTION_NOT_FOUND',404)
      if(data?.state!==(assigned?'assigned':'unassigned')||typeof data.changed!=='boolean'||![data.disabledRules,data.cancelledJobs].every(n=>Number.isSafeInteger(n)&&n>=0))throw new SocialOAuthError('SOCIAL_BOT_RESPONSE_INVALID',503)
      return {state:data.state,changed:data.changed,disabledRules:data.disabledRules,cancelledJobs:data.cancelledJobs}
    }
  }
}
