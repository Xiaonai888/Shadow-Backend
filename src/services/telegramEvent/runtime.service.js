import {createEventAdmin} from './admin.service.js'
import {createEventManual} from './manual.service.js'
import {createEventQueue,safeEventError} from './queue.service.js'
import {createEventWorker} from './worker.service.js'
import {createEventScheduler} from './scheduler.service.js'
import {sendEventTelegram} from './telegram.service.js'
import {createEventDestinationVerifier} from './destinations.service.js'

export function createTelegramEventRuntime({db,env=process.env,send=sendEventTelegram,clock=Date.now,onError=()=>{},destinationFetch=globalThis.fetch}) {
  const token=()=>String(env.TELEGRAM_EVENT_BOT_TOKEN||'').trim()
  const tokenConfigured=()=>/^\d+:[A-Za-z0-9_-]+$/.test(token())
  const enabled=()=>env.TELEGRAM_EVENT_ENABLED==='true'&&tokenConfigured()
  const report=event=>{try {onError({...event,message:safeEventError(event?.message)})} catch {}}
  const queue=createEventQueue(db)
  const worker=createEventWorker({queue,token,send,onError:report})
  const scheduler=createEventScheduler({queue,worker,enabled,clock,onError:report})
  const wake=()=>scheduler.wake()
  const options={tokenConfigured,runtimeEnabled:enabled,wake}
  const verifyDestinations=createEventDestinationVerifier({token,fetchImpl:destinationFetch})
  const admin=createEventAdmin(db,{...options,publicUrl:env.R2_PUBLIC_URL,verifyDestinations})
  const postNow=createEventManual(db,options)
  return Object.freeze({admin,postNow,tokenConfigured,enabled,start:()=>scheduler.start(),wake,stop:()=>scheduler.stop(),tick:()=>scheduler.tick()})
}
