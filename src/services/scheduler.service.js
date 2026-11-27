import { safeEventError } from './queue.service.js'

const IDLE_MS=10*60*1000
const MIN_MS=1000
export function createEventScheduler({queue,worker,enabled=()=>false,clock=Date.now,onError=()=>{}}) {
  if (!queue?.prepare || !queue?.nextDue || !worker?.run) throw new TypeError('Missing event scheduler dependencies')
  let started=false,running=false,timer=null,timerDue=Infinity,wakePending=false,failures=0
  function report(error) {try {onError({code:'TELEGRAM_EVENT_SCHEDULER_FAILED',message:safeEventError(error)})} catch {}}
  async function tick() {
    if (!enabled()) return IDLE_MS
    await queue.prepare()
    const result=await worker.run()
    if (result?.state==='disabled') return IDLE_MS
    const due=await queue.nextDue()
    const ms=due==null?Infinity:Date.parse(due)
    if (Number.isNaN(ms)) throw new Error('Invalid next event due time')
    return Math.max(MIN_MS,Math.min(IDLE_MS,ms-clock()))
  }
  function schedule(delay) {
    if (!started || !enabled()) return
    const due=clock()+Math.max(MIN_MS,delay)
    if (timer && timerDue<=due) return
    if (timer) clearTimeout(timer)
    timerDue=due
    timer=setTimeout(()=>{timer=null;timerDue=Infinity;void run()},Math.max(MIN_MS,due-clock()))
    timer.unref?.()
  }
  async function run() {
    if (!started || !enabled()) return
    if (running) {wakePending=true;return}
    running=true
    let delay=IDLE_MS
    try {delay=await tick();failures=0}
    catch(error) {failures=Math.min(6,failures+1);delay=Math.min(30*60000,60000*2**(failures-1));report(error)}
    finally {running=false;const immediate=wakePending&&failures===0;wakePending=false;schedule(immediate?MIN_MS:delay)}
  }
  return {
    tick,
    start(){if(started||!enabled())return false;started=true;schedule(MIN_MS);return true},
    wake(){if(!started||!enabled())return false;if(running)wakePending=true;else schedule(failures?60000:MIN_MS);return true},
    stop(){started=false;wakePending=false;if(timer)clearTimeout(timer);timer=null;timerDue=Infinity}
  }
}
