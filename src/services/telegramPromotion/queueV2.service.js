const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const safe=v=>String(v||'Unknown').replace(/\b\d+:[A-Za-z0-9_-]{10,}\b/g,'[redacted]').slice(0,500)
const topics=new Set(['gl','bl','romance','fantasy','comedy','trending','hidden','completed','short','new','similar','night','author'])
const validId=v=>Number.isSafeInteger(v)&&v>0
function result(response){if(response?.error)throw new Error(`Promotion V2 queue: ${safe(response.error.message)}`);return response?.data}
function date(v){if(v==null)throw new TypeError('Missing date');const d=new Date(v);if(!Number.isFinite(d.getTime()))throw new TypeError('Invalid date');return d.toISOString()}
function envelope(message){
  if(Array.isArray(message?.media)){
    const first=message.media[0];if(message.media.length<3||message.media.length>5||message.media.some(m=>m?.type!=='photo'||typeof m.media!=='string')||typeof first?.caption!=='string'||first.caption.length>1000)throw new TypeError('Invalid album payload')
    return {photo:first.media,caption:first.caption,caption_entities:first.caption_entities||[],reply_markup:{inline_keyboard:[]},media:message.media}
  }
  if(typeof message?.photo!=='string'||typeof message.caption!=='string'||message.caption.length>1000||!Array.isArray(message.reply_markup?.inline_keyboard))throw new TypeError('Invalid photo payload')
  return message
}
export function createPromotionQueueV2(db){
  if(!db?.rpc)throw new TypeError('Missing Supabase client')
  return {
    async enqueueOptional({language,slot,postType,topic,captionId=null,candidates,message,cooldownDays=14}){
      if(!['km','en'].includes(language)||!['solo','group'].includes(postType)||!topics.has(topic)||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(slot?.slotKey||'')||!Array.isArray(candidates))throw new TypeError('Invalid optional job')
      if((postType==='solo'&&candidates.length!==1)||(postType==='group'&&(candidates.length<3||candidates.length>5||!captionId))||(topic==='night'&&(postType!=='group'||candidates.length!==3)))throw new TypeError('Invalid candidate count')
      if(!(topic==='night'?[1,3,7,14]:[14]).includes(cooldownDays))throw new TypeError('Invalid cooldown')
      const items=candidates.map(c=>({storyId:c?.story?.id,episodeId:c?.episode?.id}));if(items.some(i=>!uuid.test(i.storyId||'')||!uuid.test(i.episodeId||''))||new Set(items.map(i=>i.storyId.toLowerCase())).size!==items.length)throw new TypeError('Invalid story or episode IDs')
      const payload=envelope(message)
      if(postType==='group'&&(!Array.isArray(payload.media)||payload.media.length!==items.length))throw new TypeError('Group album mismatch')
      if(postType==='group'&&(!Array.isArray(message.storyIds)||message.storyIds.length!==items.length||message.storyIds.some((id,i)=>id!==items[i].storyId)))throw new TypeError('Group story order mismatch')
      return result(await db.rpc('telegram_promotion_v2_enqueue_optional',{p_language:language,p_slot:slot.slotKey,p_post_type:postType,p_topic:topic,p_caption_id:captionId,p_items:items,p_payload:payload,p_due_at:date(slot.dueAt),p_expires_at:date(slot.expiresAt),p_cooldown_days:cooldownDays}))
    },
    async finish(job,outcome,{sent=null,error=null,retrySeconds=null}={}){
      if(!uuid.test(job?.id||'')||!Number.isInteger(job.attempts)||job.attempts<1||job.attempts>5||!['sent','retry','failed','uncertain','cancelled'].includes(outcome))throw new TypeError('Invalid outcome')
      const ids=sent?.messageIds??null
      if(outcome==='sent'&&(!Array.isArray(ids)||ids.length!==(Array.isArray(job.payload?.media)?job.payload.media.length:1)||ids.some(id=>!validId(id))||new Set(ids).size!==ids.length||ids[0]!==sent.messageId||(ids.length>1&&!sent.mediaGroupId)))throw new TypeError('Invalid delivery result')
      if(retrySeconds!==null&&(!Number.isInteger(retrySeconds)||retrySeconds<1||retrySeconds>2147483647))throw new TypeError('Invalid retry delay')
      return result(await db.rpc('telegram_promotion_v2_finish',{p_id:job.id,p_attempt:job.attempts,p_outcome:outcome,p_error:error==null?null:safe(error),p_message_ids:outcome==='sent'?ids:null,p_media_group_id:outcome==='sent'?sent.mediaGroupId??null:null,p_retry_seconds:retrySeconds}))
    }
  }
}
