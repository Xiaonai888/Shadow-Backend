import { createHash } from 'node:crypto'

export function eventBotKey(token) {
  if (typeof token!=='string' || !token.trim()) throw new TypeError('Missing event bot token')
  return createHash('sha256').update(token.trim()).digest('hex')
}
export function safeEventError(value) {
  return String(value?.message || value || 'UNKNOWN').replace(/\d+(?::|%3a)[A-Za-z0-9_-]+/gi,'[redacted]').replace(/Bearer\s+\S+/gi,'Bearer [redacted]').slice(0,500)
}
export function createEventQueue(db) {
  if (!db?.rpc) throw new TypeError('Missing Supabase client')
  async function call(name,args={}) {
    const response=await db.rpc(name,args)
    if (response.error) throw new Error(`Telegram event queue: ${safeEventError(response.error.code)}`)
    return response.data
  }
  return {
    prepare:()=>call('telegram_event_prepare_v1'),
    claim:()=>call('telegram_event_claim_v1'),
    nextDue:()=>call('telegram_event_next_due_v1'),
    manual:(eventId,language,requestId)=>call('telegram_event_manual_v1',{p_event:eventId,p_language:language,p_request:requestId}),
    finish:(job,outcome,{code=null,error=null,messageId=null,retrySeconds=null,fileId=null,botKey=null}={})=>call('telegram_event_finish_v1',{
      p_id:job.id,p_lease:job.lease_id,p_outcome:outcome,p_code:code?String(code).slice(0,100):null,p_error:error?safeEventError(error):null,
      p_message_id:messageId,p_retry_seconds:retrySeconds,p_image_key:job.image_key??null,p_file_id:fileId,p_bot_key:botKey
    })
  }
}
