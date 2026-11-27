import { editPromotionCaptionV2 } from './telegramV2.service.js'

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const states=new Set(['disabled','missing_event','existing','legacy_existing','not_due','ineligible','legacy_day','needs_payload','queued'])
const safe=v=>String(v?.message||v||'Unknown').replace(/\b\d+:[A-Za-z0-9_-]{10,}\b/g,'[redacted]').slice(0,500)
const positive=v=>Number.isSafeInteger(v)&&v>0
function result(response){if(response?.error)throw new Error(`Promotion V2 update queue: ${safe(response.error.message)}`);return response?.data}
function language(value){if(!['km','en'].includes(value))throw new TypeError('Invalid update language');return value}
function id(value){if(!uuid.test(value||''))throw new TypeError('Invalid update ID');return value}
function payload(message){
  if(message==null)return null
  if(Array.isArray(message.media)){
    const first=message.media[0]
    if(message.media.length<3||message.media.length>5||message.media.some((m,i)=>m?.type!=='photo'||typeof m.media!=='string'||(i>0&&(m.caption!==undefined||m.caption_entities!==undefined))))throw new TypeError('Invalid update album')
    message={photo:first.media,caption:first.caption,caption_entities:first.caption_entities||[],reply_markup:{inline_keyboard:[]},media:message.media}
  }
  if(typeof message.photo!=='string'||typeof message.caption!=='string'||message.caption.length>960||!Array.isArray(message.reply_markup?.inline_keyboard))throw new TypeError('Invalid update message or missing UP caption reserve')
  if(message.caption_entities!==undefined&&(!Array.isArray(message.caption_entities)||message.caption_entities.some(e=>!e||!Number.isInteger(e.offset)||!positive(e.length)||e.offset<0||e.offset+e.length>message.caption.length)))throw new TypeError('Invalid caption entities')
  const {v2_base_caption,v2_revision,...clean}=message
  return clean
}
export function createPromotionUpdateQueueV2(db){
  if(!db?.rpc)throw new TypeError('Missing Supabase client')
  return {
    async enqueue({language:lang,episodeId,message=null}){
      const data=result(await db.rpc('telegram_promotion_v2_enqueue_update',{p_language:language(lang),p_episode_id:id(episodeId),p_payload:payload(message)}))
      if(!states.has(data?.state)||(['queued','existing','legacy_existing'].includes(data.state)&&!uuid.test(data.queueId||'')))throw new TypeError('Invalid update enqueue result')
      return data
    },
    async finish(job,outcome,{sent=null,error=null,retrySeconds=null}={}){
      if(job?.kind!=='update'||!uuid.test(job.id||'')||!positive(job.attempts)||job.attempts>5||!positive(job.payload?.v2_revision)||!['sent','retry','failed','uncertain','cancelled'].includes(outcome))throw new TypeError('Invalid update send outcome')
      if(retrySeconds!==null&&(!positive(retrySeconds)||retrySeconds>2147483647))throw new TypeError('Invalid retry delay')
      const expected=Array.isArray(job.payload.media)?job.payload.media.length:1
      const ids=sent?.messageIds
      if(outcome==='sent'&&(!Array.isArray(ids)||ids.length!==expected||ids.some(i=>!positive(i))||new Set(ids).size!==ids.length||ids[0]!==sent.messageId||(expected>1?!sent.mediaGroupId:sent.mediaGroupId!=null)))throw new TypeError('Invalid delivery IDs')
      return result(await db.rpc('telegram_promotion_v2_finish_update',{p_id:job.id,p_attempt:job.attempts,p_outcome:outcome,p_revision:job.payload.v2_revision,p_error:error==null?null:safe(error),p_message_ids:outcome==='sent'?ids:null,p_media_group_id:outcome==='sent'?sent.mediaGroupId??null:null,p_retry_seconds:retrySeconds}))
    },
    async claimEdit(lang){
      const data=result(await db.rpc('telegram_promotion_v2_claim_edit',{p_language:language(lang)}))
      if(data==null)return null
      if(!uuid.test(data.queueId||'')||!uuid.test(data.claimId||'')||!positive(data.revision)||!positive(data.attempt)||data.attempt>5||!positive(data.messageId)||!/^\-100\d+$/.test(data.chatId||'')||data.payload?.v2_revision!==data.revision||typeof data.payload.caption!=='string')throw new TypeError('Invalid edit claim')
      return data
    },
    async finishEdit(claim,outcome,{error=null,retrySeconds=null}={}){
      if(!['edited','retry','failed'].includes(outcome)||!uuid.test(claim?.queueId||'')||!uuid.test(claim?.claimId||'')||(retrySeconds!==null&&(!positive(retrySeconds)||retrySeconds>2147483647)))throw new TypeError('Invalid edit outcome')
      return result(await db.rpc('telegram_promotion_v2_finish_edit',{p_id:claim.queueId,p_claim_id:claim.claimId,p_outcome:outcome,p_error:error==null?null:safe(error),p_retry_seconds:retrySeconds}))
    },
    async nextEditDue(lang){return result(await db.rpc('telegram_promotion_v2_next_edit_due',{p_language:language(lang)}))}
  }
}
export function createPromotionEditWorkerV2({queue,token,edit=editPromotionCaptionV2,onError=()=>{}}){
  if(!queue?.claimEdit||!queue?.finishEdit)throw new TypeError('Missing edit queue')
  return {
    async run(settings){
      if(!settings?.enabled||!['km','en'].includes(settings.language)||!settings.channel_id)return {state:'disabled'}
      const secret=String(typeof token==='function'?token(settings.language):token||'').trim()
      if(!/^\d+:[A-Za-z0-9_-]+$/.test(secret))return {state:'disabled'}
      const claim=await queue.claimEdit(settings.language)
      if(!claim)return {state:'idle'}
      let outcome='edited',options={}
      try{
        if(claim.chatId!==String(settings.channel_id))throw Object.assign(new Error('Promotion edit channel changed'),{status:400})
        await edit({token:secret,chatId:claim.chatId,messageId:claim.messageId,message:claim.payload})
      }catch(error){
        const retry=error?.uncertain||!error?.status||error.status>=500||error.status===429
        outcome=retry?'retry':'failed'
        options={error:safe(error),retrySeconds:retry?Math.min(2147483647,Math.max(60,Math.ceil(Number(error?.retryAfter)||300))):null}
        try{onError({code:'PROMOTION_EDIT_FAILED',job_id:claim.queueId,language:settings.language,message:options.error})}catch{}
      }
      if(!await queue.finishEdit(claim,outcome,options))throw new Error('Promotion edit lease lost')
      return {state:outcome,jobId:claim.queueId}
    }
  }
}
