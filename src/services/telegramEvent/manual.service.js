import { EventAdminError, requireId, requireLanguage } from './validation.service.js'

const errors={EVENT_INVALID_INPUT:[400,'Invalid post request'],EVENT_NOT_FOUND:[404,'Event not found'],EVENT_INVALID_STATUS:[409,'Event is not ready for posting'],EVENT_CHANNEL_NOT_READY:[409,'Configure and enable the channel first'],EVENT_NO_ENABLED_CONTENT:[409,'Enable content for this language first']}
export function createEventManual(db,{runtimeEnabled=()=>false,tokenConfigured=()=>false,wake=()=>{}}={}) {
  if (!db?.rpc) throw new TypeError('Missing Supabase client')
  return async function postNow(id,input) {
    const eventId=requireId(id)
    if (!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(key=>!['language','request_id'].includes(key))) throw new EventAdminError('Invalid post request')
    const language=requireLanguage(input.language)
    const requestId=requireId(input.request_id)
    if (!runtimeEnabled() || !tokenConfigured()) throw new EventAdminError('Telegram Event Bot is not enabled',409,'EVENT_BOT_DISABLED')
    const result=await db.rpc('telegram_event_manual_v1',{p_event:eventId,p_language:language,p_request:requestId})
    if (result.error) {
      const code=String(result.error.message||'')
      if (Object.hasOwn(errors,code)) throw new EventAdminError(errors[code][1],errors[code][0],code)
      throw new Error(`Telegram event manual queue: ${String(result.error.code||'UNKNOWN').slice(0,30)}`)
    }
    const jobId=requireId(result.data)
    try {wake()} catch {}
    return {job_id:jobId,queued:true}
  }
}
