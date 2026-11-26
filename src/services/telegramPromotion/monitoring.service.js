import { randomUUID } from 'node:crypto'
const HEARTBEAT_MS=10*60000
const ERROR_HEARTBEAT_MS=10*60000
const languages=new Set(['km','en','zh','ko','ja'])
const safeError=value=>String(value?.message||value||'UNKNOWN').replace(/\b\d+(?::|%3a)[A-Za-z0-9_-]+/gi,'[redacted]').replace(/Bearer\s+\S+/gi,'Bearer [redacted]').slice(0,300)
export function createPromotionMonitor(db,{clock=Date.now,instanceId=randomUUID(),onError=()=>{}}={}) {
  if(!db?.rpc)throw new TypeError('Missing monitoring database')
  const states=new Map()
  const active=new Set()
  async function heartbeat(language,ok,error=null) {
    if(!languages.has(language)||typeof ok!=='boolean')throw new TypeError('Invalid monitoring heartbeat')
    if(active.has(language))return false
    const now=clock()
    const previous=states.get(language)
    if(previous&&previous.ok===ok&&now>=previous.at&&now-previous.at<(ok?HEARTBEAT_MS:ERROR_HEARTBEAT_MS))return false
    active.add(language)
    try {
      const response=await db.rpc('telegram_promotion_heartbeat_v1',{p_language:language,p_instance_id:instanceId,p_ok:ok,p_error:ok?null:safeError(error)})
      if(response.error)throw new Error(response.error.message||'Heartbeat write failed')
      if(response.data!==true)throw new Error('Heartbeat not confirmed')
      states.set(language,{at:now,ok})
      return true
    }catch(error){
      try{onError({code:'TELEGRAM_PROMOTION_MONITOR_FAILED',language,message:safeError(error)})}catch{}
      return false
    }finally{active.delete(language)}
  }
  async function report() {
    const response=await db.rpc('telegram_promotion_monitor_status_v1')
    if(response.error)throw new Error(safeError(response.error.message))
    return response.data||[]
  }
  return {heartbeat,report}
}
