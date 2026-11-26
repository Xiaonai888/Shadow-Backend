const LANGUAGES=new Set(['km','en','zh','ko','ja'])
const PAGE_SIZE=10
const CACHE_MS=30000
const historyFields='language,checkpoint_at,checked_at,window_from,worker_state,last_seen_at,last_success_at,recovery_completed_through,published_candidates,missing_events,pending_events,ready_posts,sending_posts,sent_updates,failed_posts,uncertain_posts'
const safe=value=>String(value?.message??value??'UNKNOWN').replace(/\b\d+(?::|%3a)[A-Za-z0-9_-]+/gi,'[redacted]').replace(/Bearer\s+\S+/gi,'Bearer [redacted]').slice(0,300)
const count=value=>Math.max(0,Number(value)||0)
export class PromotionReportInputError extends Error {}
function validateLanguage(value){if(typeof value!=='string'||!LANGUAGES.has(value))throw new PromotionReportInputError('Invalid language');return value}
export function parsePromotionHistoryQuery(query={}){
  const language=validateLanguage(query.language??'km')
  const raw=query.page??'1'
  if(typeof raw!=='string'||!/^\d{1,2}$/.test(raw)||Number(raw)<1||Number(raw)>10)throw new PromotionReportInputError('Page must be 1–10')
  return {language,page:Number(raw)}
}
export function promotionCheckpointAlerts(row){
  if(!row)return []
  const alerts=[]
  const add=(code,severity,n=null)=>alerts.push({code,severity,count:n,language:row.language,checkpoint_at:row.checkpoint_at,checked_at:row.checked_at})
  if(row.worker_state==='stale')add('WORKER_STALE','error')
  if(row.worker_state==='error')add('WORKER_ERROR','error')
  if(count(row.missing_events))add('MISSING_PUBLISH_EVENTS','warning',count(row.missing_events))
  if(count(row.failed_posts))add('FAILED_POSTS','error',count(row.failed_posts))
  if(count(row.uncertain_posts))add('UNCERTAIN_DELIVERY','warning',count(row.uncertain_posts))
  return alerts
}
export function currentPromotionAlerts(row,runtimeEnabled){
  if(!row?.enabled)return []
  const make=(code,severity)=>({code,severity,language:row.language,last_seen_at:row.last_seen_at??null})
  if(!runtimeEnabled)return [make('RUNTIME_DISABLED','warning')]
  if(row.worker_state==='stale')return [make('WORKER_STALE','error')]
  if(row.worker_state==='error')return [make('WORKER_ERROR','error')]
  return []
}
export function createPromotionMonitorReport(db,{clock=Date.now,runtimeEnabled=()=>false}={}){
  if(!db?.rpc||!db?.from)throw new TypeError('Missing monitoring database')
  let cached=null,pending=null
  async function status(){
    const now=clock(),enabled=Boolean(runtimeEnabled())
    if(cached&&cached.runtime_enabled===enabled&&now>=cached.at&&now-cached.at<CACHE_MS)return cached.value
    if(pending)return pending
    pending=(async()=>{
      const {data,error}=await db.rpc('telegram_promotion_monitor_status_v1')
      if(error)throw new Error(safe(error))
      if(!Array.isArray(data))throw new Error('Invalid promotion monitor response')
      const value={runtime_enabled:enabled,measured_at:new Date(clock()).toISOString(),languages:data.map(row=>({...row,last_error:row.last_error?safe(row.last_error):null,current_alerts:currentPromotionAlerts(row,enabled),checkpoint_alerts:promotionCheckpointAlerts(row.last_checkpoint)}))}
      cached={at:clock(),runtime_enabled:enabled,value}
      return value
    })()
    try{return await pending}finally{pending=null}
  }
  async function history(query){
    const {language,page}=parsePromotionHistoryQuery(query)
    const from=(page-1)*PAGE_SIZE
    const {data,error}=await db.from('telegram_promotion_watchdog_history').select(historyFields).eq('language',language).order('checkpoint_at',{ascending:false}).range(from,from+PAGE_SIZE)
    if(error)throw new Error(safe(error))
    if(!Array.isArray(data))throw new Error('Invalid promotion history response')
    return {language,page,has_more:data.length>PAGE_SIZE,items:data.slice(0,PAGE_SIZE).map(row=>({...row,alerts:promotionCheckpointAlerts(row)}))}
  }
  return {status,history}
}
