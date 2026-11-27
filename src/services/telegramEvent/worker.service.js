import { eventBotKey,safeEventError } from './queue.service.js'

export function createEventWorker({queue,token,send,onError=()=>{}}) {
  if (!queue?.claim || !queue?.finish || typeof send!=='function') throw new TypeError('Missing event worker dependencies')
  const report=(code,job,error)=>{try {onError({code,job_id:job?.id||null,language:job?.language||null,message:safeEventError(error)})} catch {}}
  async function finish(job,state,options) {
    if (!await queue.finish(job,state,options)) {
      report('EVENT_LEASE_LOST',job,'Delivery outcome requires review')
      return {state:'uncertain',id:job.id}
    }
    return {state,id:job.id}
  }
  return {
    async run() {
      const secret=String(typeof token==='function'?token():token||'').trim()
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(secret)) return {state:'disabled'}
      const job=await queue.claim()
      if (!job) return {state:'idle'}
      const botKey=eventBotKey(secret)
      const fileId=job.image_url && job.photo_bot_key===botKey?job.photo_file_id:null
      let sent
      try {
        try {sent=await send({token:secret,job,fileId})}
        catch(error) {
          if (!fileId || error?.uncertain || error?.status!==400 || error?.code!=='INVALID_FILE_ID') throw error
          sent=await send({token:secret,job,fileId:null})
        }
      } catch(error) {
        report('EVENT_SEND_FAILED',job,error)
        const status=Number(error?.status)
        const code=`TELEGRAM_${Number.isInteger(status)&&status>0?status:'UNKNOWN'}`
        if (error?.uncertain || !status || status>=500) return finish(job,'uncertain',{code,error})
        if (status===429) {
          const delay=Number(error.retryAfter)
          const retrySeconds=Number.isFinite(delay)&&delay>0?Math.min(86400,Math.max(1,Math.ceil(delay))):60
          return finish(job,'retry',{code,error,retrySeconds})
        }
        return finish(job,'failed',{code,error})
      }
      if (!Number.isSafeInteger(sent?.messageId) || sent.messageId<=0) return finish(job,'uncertain',{code:'INVALID_TELEGRAM_RESPONSE',error:'No confirmed message ID'})
      return finish(job,'sent',{messageId:sent.messageId,fileId:job.image_url&&typeof sent.fileId==='string'&&sent.fileId.length<=1024?sent.fileId:null,botKey})
    }
  }
}
