import { supabase } from '../../config/supabase.js'
import { createPromotionQueue } from './queue.service.js'
import { createPromotionStorySource } from './storySource.service.js'
import { createPromotionCandidates } from './candidates.service.js'
import { createPromotionWorker } from './worker.service.js'
import { createPromotionRecovery } from './recovery.service.js'
import { createPromotionScheduler } from './scheduler.service.js'
import { createPromotionMonitor } from './monitoring.service.js'
import { createPromotionAlertDelivery } from './alertDelivery.service.js'
import { sendTelegramMessage } from '../telegram.service.js'

const v2Requested=process.env.TELEGRAM_PROMOTION_V2_ENABLED==='true'
let v2=null
const enabled=()=>process.env.TELEGRAM_PROMOTION_ENABLED==='true'&&(!v2Requested||v2!==null)
const token=language=>String(process.env[`TELEGRAM_PROMOTION_BOT_TOKEN_${String(language).toUpperCase()}`] || process.env.TELEGRAM_PROMOTION_BOT_TOKEN || '').trim()
const onError=event=>console.error('TELEGRAM_PROMOTION_ERROR',JSON.stringify(event))
const queue=createPromotionQueue(supabase)
const source=createPromotionStorySource(supabase)
const candidates=createPromotionCandidates(supabase,source)
const recovery=createPromotionRecovery(supabase,source)
const worker=createPromotionWorker({queue,candidates,token,onError})
const healthMonitor=createPromotionMonitor(supabase,{onError})
const alerts=createPromotionAlertDelivery(supabase,{
  send:sendTelegramMessage,
  chatId:()=>process.env.TELEGRAM_PROMOTION_ALERT_CHAT_ID,
  configured:()=>Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()),
  onError,
})
const monitor={...healthMonitor,async heartbeat(...args){
  const result=await healthMonitor.heartbeat(...args)
  void alerts.pulse()
  return result
}}
if(v2Requested){
  try{
    const {createPromotionIntegrationV2}=await import('./integrationV2.service.js')
    v2=createPromotionIntegrationV2({db:supabase,queue,source,candidates,token,onError,safeCoverUrl:process.env.TELEGRAM_PROMOTION_SAFE_COVER_URL||null})
  }catch(error){
    onError({code:'TELEGRAM_PROMOTION_V2_INIT_FAILED',message:String(error?.message||'Initialization failed').replace(/\b\d+:[A-Za-z0-9_-]{10,}\b/g,'[redacted]').slice(0,300)})
  }
}
const scheduler=createPromotionScheduler({queue,source,candidates,worker,recovery,enabled,token,onError,monitor,v2})
export const startTelegramPromotionScheduler=()=>scheduler.start()
export const wakeTelegramPromotionScheduler=()=>scheduler.wake()
export const stopTelegramPromotionScheduler=()=>scheduler.stop()
