import { latestRecoveryCheckpoint,nextRecoveryCheckpoint } from './recoveryClock.service.js'
const WAIT=120000
const RETRY=600000
const safe=value=>String(value?.message||value||'UNKNOWN').replace(/\b\d+(?::|%3a)[A-Za-z0-9_-]+/gi,'[redacted]').replace(/Bearer\s+\S+/gi,'Bearer [redacted]').slice(0,300)
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
const count=value=>Math.max(0,Number(value)||0)
const iso=ms=>new Date(ms).toISOString()
export function formatPromotionAlert(checkpoint,rows){
  const time=new Date(checkpoint).toLocaleString('en-GB',{timeZone:'Asia/Phnom_Penh',hour12:false})
  return ['⚠️ <b>Shadow Telegram Promotion Alert</b>',`Checkpoint: ${escape(time)} (Cambodia)`,'Historical watchdog snapshot — verify current status in System Control.',...rows.flatMap(row=>['',`<b>${escape(row.language.toUpperCase())}</b> · ${escape(row.worker_state)}`,`Missing events: ${count(row.missing_events)} | Failed: ${count(row.failed_posts)} | Uncertain: ${count(row.uncertain_posts)}`]),'Do not resend uncertain posts automatically.'].join('\n')
}
export function createPromotionAlertDelivery(db,{send,chatId=()=>'',configured=()=>false,clock=Date.now,onError=()=>{}}={}){
  if(!db?.rpc||!db?.from||typeof send!=='function')throw new TypeError('Missing alert dependencies')
  let next=0,pending=null
  const report=error=>{try{onError({code:'TELEGRAM_PROMOTION_ALERT_FAILED',message:safe(error)})}catch{}}
  async function finish(checkpoint,status,messageId,error){
    const result=await db.from('telegram_promotion_alert_delivery').update({status,telegram_message_id:messageId,finished_at:iso(clock()),last_error:error}).eq('checkpoint_at',iso(checkpoint)).eq('status','sending').select('checkpoint_at').maybeSingle()
    if(result.error||!result.data)throw new Error(result.error?.message||'Alert confirmation missing')
  }
  function pulse(){
    const now=clock(),destination=String(chatId()||'').trim()
    if(!configured()||! /^-?\d{5,20}$/.test(destination)||now<next)return Promise.resolve(false)
    if(pending)return pending
    next=now+RETRY
    const checkpoint=latestRecoveryCheckpoint(now-WAIT)
    pending=(async()=>{
      const {data,error}=await db.rpc('telegram_promotion_claim_alert_v1',{p_checkpoint:iso(checkpoint),p_chat_id:destination})
      if(error)throw new Error(error.message)
      if(typeof data?.ready!=='boolean'||!Array.isArray(data.rows)||data.rows.length>5)throw new Error('Invalid alert claim response')
      if(!data.ready)return false
      next=nextRecoveryCheckpoint(now-WAIT)+WAIT
      if(!data.rows.length)return false
      let messageId=null
      try{
        const result=await send(formatPromotionAlert(checkpoint,data.rows),{chat_id:destination})
        if(result?.ok!==true||!Number.isSafeInteger(result?.result?.message_id)||result.result.message_id<=0)throw new Error('Alert delivery not confirmed')
        messageId=result.result.message_id
      }catch(error){
        report(error)
        await finish(checkpoint,'uncertain',null,safe(error))
        return false
      }
      await finish(checkpoint,'sent',messageId,null)
      return true
    })().catch(error=>{report(error);return false}).finally(()=>{pending=null})
    return pending
  }
  return {pulse}
}
