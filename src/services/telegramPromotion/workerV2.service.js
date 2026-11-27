import { sendPromotionV2 } from './telegramV2.service.js'
import { sendPromotionPhoto } from './telegram.service.js'
const safe=e=>String(e?.message||e||'Unknown').replace(/\b\d+:[A-Za-z0-9_-]{10,}\b/g,'[redacted]').slice(0,300)
export function createPromotionWorkerV2({queue,optionalQueue,updateQueue,validator,token,send=sendPromotionV2,sendLegacy=sendPromotionPhoto,onError=()=>{}}){
  if(!queue?.claim||!queue?.finish||!optionalQueue?.finish||!updateQueue?.finish||!validator?.validate)throw new TypeError('Missing V2 worker dependencies')
  const notify=(code,job,error)=>{try{onError({code,job_id:job.id,language:job.language,message:safe(error)})}catch{}}
  const finish=async(job,mode,outcome,options={})=>{
    const ok=mode==='update'?await updateQueue.finish(job,outcome,options):mode==='optional'?await optionalQueue.finish(job,outcome,options):await queue.finish(job,outcome,{error:options.error,messageId:options.sent?.messageId??null,retrySeconds:options.retrySeconds??null})
    if(!ok)throw new Error('Promotion job lease lost')
    return {state:outcome,jobId:job.id}
  }
  return {async run(settings){
    const secret=String(typeof token==='function'?token(settings?.language):token||'').trim()
    if(!settings?.enabled||!settings.channel_id||!/^\d+:[A-Za-z0-9_-]+$/.test(secret))return {state:'disabled'}
    const job=await queue.claim(settings.language)
    if(!job)return {state:'idle'}
    const mode=job.kind==='update'&&Number.isInteger(job.payload?.v2_revision)?'update':['solo','group'].includes(job.kind)?'optional':'legacy'
    if(job.language!==settings.language||String(job.telegram_chat_id)!==String(settings.channel_id))return finish(job,mode,'cancelled',{error:'CHANNEL_CHANGED'})
    let fileId=null
    try{
      const decision=await validator.validate(job,Date.now(),settings)
      if(!decision.eligible)return finish(job,mode,'cancelled',{error:decision.reason})
      if(!Array.isArray(job.payload.media)&&queue.getFileId)try{fileId=await queue.getFileId(secret,job.payload.photo)}catch(e){notify('PROMOTION_CACHE_READ_FAILED',job,e)}
    }catch(e){notify('PROMOTION_VALIDATE_FAILED',job,e);return finish(job,mode,'retry',{error:safe(e),retrySeconds:300})}
    const deliver=mode==='legacy'?sendLegacy:send
    let sent
    try{
      try{sent=await deliver({token:secret,chatId:job.telegram_chat_id,message:job.payload,fileId})}catch(e){
        if(!fileId||e.status!==400||e.uncertain)throw e
        try{await queue.removeFileId(secret,job.payload.photo)}catch(err){notify('PROMOTION_CACHE_REMOVE_FAILED',job,err)}
        sent=await deliver({token:secret,chatId:job.telegram_chat_id,message:job.payload,fileId:null})
      }
    }catch(e){
      notify('PROMOTION_SEND_FAILED',job,e)
      if(e.uncertain||!e.status||e.status>=500)return finish(job,mode,'uncertain',{error:safe(e)})
      if(e.status===429)return finish(job,mode,'retry',{error:safe(e),retrySeconds:Math.max(60,Math.min(2147483647,Math.ceil(Number(e.retryAfter)||300)))})
      return finish(job,mode,'failed',{error:safe(e)})
    }
    const outcome=await finish(job,mode,'sent',{sent})
    if(sent.fileId&&queue.saveFileId)try{await queue.saveFileId(secret,job.payload.photo,sent.fileId)}catch(e){notify('PROMOTION_CACHE_WRITE_FAILED',job,e)}
    return outcome
  }}
}
