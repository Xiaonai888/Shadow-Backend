import { nextRecoveryCheckpoint, recoverablePromotionSlots } from './recoveryClock.service.js'
import { prepareUpdateEvents } from './storySource.service.js'

const IDLE = 10 * 60000
const MIN = 1000
const SLOT_RETRY = 15 * 60000
const RECOVERY_CONTINUE = 5000
const DAY = 86400000
const safe = value => String(value?.message || value || 'UNKNOWN').replace(/\b\d+:[A-Za-z0-9_-]{10,}\b/g,'[redacted]').slice(0,300)
const dateMs = value => { const n = Date.parse(value || ''); return Number.isFinite(n) ? n : Infinity }
export function nextPromotionSlot(schedule, now = Date.now()) {
  const local = new Date(now + 7 * 3600000)
  const midnight = Math.floor(local.getTime() / DAY) * DAY - 7 * 3600000
  let next = Infinity
  for (let d = 0; d <= 7; d++) {
    const weekday = (local.getUTCDay() + d) % 7
    for (const slot of Array.isArray(schedule) ? schedule : []) {
      if (slot?.day !== weekday || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(slot.time) || !['completed','short','trending','author'].includes(slot.kind)) continue
      const [h,m] = slot.time.split(':').map(Number)
      const due = midnight + d * DAY + (h * 60 + m) * 60000
      if (due > now) next = Math.min(next, due)
    }
  }
  return next
}
export function createPromotionScheduler({queue,source,candidates,worker,recovery,enabled=()=>false,token=()=>'',onError=()=>{},clock=Date.now,prepare=prepareUpdateEvents,monitor=null,v2=null}) {
  if (![queue,source,candidates,worker,recovery].every(Boolean)) throw new TypeError('Missing scheduler dependencies')
  let running=false,started=false,timer=null,timerDue=Infinity,wakePending=false,failures=0
  const attemptedSlots=new Map()
  const completionChecks=new Map()
  const report = (error,language=null) => { try { onError({code:'TELEGRAM_PROMOTION_SCHEDULER_FAILED',language,message:safe(error)}) } catch {} }
  const canSend = settings => settings?.enabled && settings.channel_id && /^\d+:[A-Za-z0-9_-]+$/.test(String(token(settings.language)||'').trim())
  async function tick() {
    if (!enabled()) return IDLE
    const now=clock()
    let next=now+IDLE
    let errorCount=0
    for (const [key,entry] of attemptedSlots) if (entry.expiresAt<=now) attemptedSlots.delete(key)
    const settingsList=(await queue.settings()).filter(settings=>settings?.enabled)
    const heartbeat=async(language,ok,error=null)=>{
      try { await monitor?.heartbeat(language,ok,error) } catch(error) { report(error,language) }
    }
    for (const settings of settingsList) {
      if (!canSend(settings)) {
        await heartbeat(settings.language,false,'Missing channel or bot token')
        continue
      }
      try {
        const modern=Boolean(v2?.supports(settings.language))
        const restored=await recovery.step(settings,clock())
        if (restored.more) next=Math.min(next,clock()+RECOVERY_CONTINUE)
        let due=await recovery.due(settings.language)
        if (dateMs(due.event_due_at)<=clock()) {
          await (modern?v2.prepare:prepare)({source,queue,settings,now:clock(),onError})
          due=await recovery.due(settings.language)
        }
        const current=clock()
        const pendingEvent=dateMs(due.event_due_at)<=current
        const blocked=Boolean(due.update_waiting || pendingEvent || restored.more)
        let editDue=Infinity
        let edited=false
        if (modern && !blocked) {
          editDue=dateMs(await v2.updateQueue.nextEditDue(settings.language))
          if (editDue<=current) {
            const outcome=await v2.editWorker.run(settings)
            edited=outcome.state!=='idle' && outcome.state!=='disabled'
            if (edited) {
              due=await recovery.due(settings.language)
              editDue=dateMs(await v2.updateQueue.nextEditDue(settings.language))
            } else {
              editDue=current+60000
            }
          }
          next=Math.min(next,editDue)
        }
        if (!blocked && !edited) {
          if (modern && v2.completion && (completionChecks.get(settings.language)||0)<=current) {
            const completion=await v2.completion.run(settings)
            const nextCheck=current+(completion.queued>=3?60000:IDLE)
            completionChecks.set(settings.language,nextCheck)
            next=Math.min(next,nextCheck)
            if(completion.queued>0)due=await recovery.due(settings.language)
          }
          let attempted=false
          const slots=modern?v2.slots(current,settings.enabled_at ?? null):recoverablePromotionSlots(settings.schedule,current,settings.enabled_at ?? null)
          for (const slot of slots) {
            const key=`${settings.language}:${slot.slotKey}`
            const prior=attemptedSlots.get(key)
            if (prior?.retryAt>current) { next=Math.min(next,prior.retryAt); continue }
            attempted=true
            const id=await (modern?v2.optional:candidates).enqueue({queue,settings,slot,now:current})
            const retryAt=id?slot.expiresAt:Math.min(slot.expiresAt,current+SLOT_RETRY)
            attemptedSlots.set(key,{expiresAt:slot.expiresAt,retryAt})
            next=Math.min(next,retryAt)
          }
          if (attempted) due=await recovery.due(settings.language)
        }
        const queueDue=dateMs(due.queue_due_at)
        if (!edited && queueDue<=clock() && (!(pendingEvent || restored.more) || due.update_ready)) {
          await (v2?.worker || worker).run(settings)
          due=await recovery.due(settings.language)
        }
        const end=clock()
        const eventDue=dateMs(due.event_due_at)
        const sendDue=dateMs(due.queue_due_at)
        if (eventDue<=end) next=Math.min(next,end+RECOVERY_CONTINUE)
        else next=Math.min(next,eventDue)
        if (sendDue>end) next=Math.min(next,sendDue)
        else if (!pendingEvent && !restored.more || due.update_ready) next=Math.min(next,end+RECOVERY_CONTINUE)
        if(modern && v2.completion && !blocked && !edited)next=Math.min(next,completionChecks.get(settings.language)||end+IDLE)
        next=Math.min(next,modern?v2.nextSlot(end):nextPromotionSlot(settings.schedule,end),nextRecoveryCheckpoint(end))
        await heartbeat(settings.language,true)
      } catch(error) { errorCount++; report(error,settings.language); await heartbeat(settings.language,false,error) }
    }
    if (errorCount) throw new Error(`${errorCount} promotion language cycle(s) failed`)
    return Math.max(MIN,Math.min(IDLE,next-clock()))
  }
  function schedule(delay) {
    if (!started || !enabled()) return
    const due=clock()+Math.max(MIN,delay)
    if (timer && timerDue<=due) return
    if (timer) clearTimeout(timer)
    timerDue=due
    timer=setTimeout(()=>{timer=null;timerDue=Infinity;void run()},Math.max(MIN,due-clock()))
    timer.unref?.()
  }
  async function run() {
    if (!started || !enabled()) return
    if (running) { wakePending=true; return }
    running=true
    let delay=IDLE
    try { delay=await tick(); failures=0 }
    catch(error) { failures=Math.min(6,failures+1); delay=Math.min(30*60000,60000*2**(failures-1)); report(error) }
    finally { running=false; const immediate=wakePending && failures===0; wakePending=false; schedule(immediate?MIN:delay) }
  }
  return {
    tick,
    start(){if(started || !enabled()) return false; started=true;schedule(MIN);return true},
    wake(){if(!started || !enabled()) return false;if(running) wakePending=true;else schedule(failures?60000:MIN);return true},
    stop(){started=false;wakePending=false;if(timer)clearTimeout(timer);timer=null;timerDue=Infinity},
  }
}
