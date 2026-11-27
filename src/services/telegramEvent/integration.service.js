import {supabase} from '../../config/supabase.js'
import {createTelegramEventRuntime} from './runtime.service.js'

const runtime=createTelegramEventRuntime({db:supabase,onError:event=>console.error('TELEGRAM_EVENT_ERROR',JSON.stringify(event))})
export const telegramEventAdmin=runtime.admin
export const telegramEventPostNow=runtime.postNow
export const startTelegramEventScheduler=runtime.start
export const wakeTelegramEventScheduler=runtime.wake
export const stopTelegramEventScheduler=runtime.stop
