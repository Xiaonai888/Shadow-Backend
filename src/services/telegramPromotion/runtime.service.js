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

const enabled=()=>process.env.TELEGRAM_PROMOTION_ENABLED==='true'
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
const scheduler=createPromotionScheduler({queue,source,candidates,worker,recovery,enabled,token,onError,monitor})
export const startTelegramPromotionScheduler=()=>scheduler.start()
export const wakeTelegramPromotionScheduler=()=>scheduler.wake()
export const stopTelegramPromotionScheduler=()=>scheduler.stop()
