export class PromotionTelegramV2Error extends Error {
  constructor(message,{status=null,retryAfter=null,uncertain=false}={}){super(message);this.name='PromotionTelegramV2Error';this.status=status;this.retryAfter=retryAfter;this.uncertain=uncertain}
}
const bad=message=>new PromotionTelegramV2Error(message,{status:400})
const validId=id=>Number.isSafeInteger(id)&&id>0
function captionFields(message){
  if(typeof message?.caption!=='string'||message.caption.length>1000)throw bad('Invalid caption')
  const fields={caption:message.caption}
  if(message.caption_entities!==undefined){
    if(!Array.isArray(message.caption_entities)||message.caption_entities.some(e=>!e||!Number.isInteger(e.offset)||!Number.isInteger(e.length)||e.offset<0||e.length<1||e.offset+e.length>message.caption.length))throw bad('Invalid caption entities')
    fields.caption_entities=message.caption_entities
  }
  return fields
}
function httpsPhoto(value){try{const u=new URL(value);if(u.protocol==='https:'&&!u.username&&!u.password)return u.href}catch{}throw bad('Invalid photo URL')}
async function call({token,chatId,method,payload,fetchImpl=globalThis.fetch,timeoutMs=15000,edit=false}){
  const secret=String(token||'').trim(),channel=String(chatId||'').trim()
  if(!/^\d+:[A-Za-z0-9_-]+$/.test(secret)||!/^(-100\d+|@[A-Za-z0-9_]{5,})$/.test(channel))throw bad('Invalid Telegram credentials or channel')
  const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),timeoutMs)
  try{
    let response,data
    try{response=await fetchImpl(`https://api.telegram.org/bot${secret}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:channel,...payload}),signal:ctrl.signal});data=await response.json()}catch{throw new PromotionTelegramV2Error('Telegram delivery result unknown',{uncertain:true})}
    if(!response.ok||data?.ok!==true){const status=Number(data?.error_code||response.status)||null;const delay=Number(data?.parameters?.retry_after);if(edit&&status===400&&/message is not modified/i.test(String(data?.description||'')))return {unchanged:true};throw new PromotionTelegramV2Error(`Telegram ${method} rejected (${status??'unknown'})`,{status,retryAfter:Number.isFinite(delay)&&delay>0?delay:null,uncertain:!status||status>=500})}
    return data.result
  }finally{clearTimeout(timer)}
}
export async function sendPromotionV2({token,chatId,message,fileId=null,fetchImpl=globalThis.fetch}){
  if(Array.isArray(message?.media)){
    if(message.media.length<3||message.media.length>5)throw bad('Invalid album size')
    const media=message.media.map((item,i)=>{if(item?.type!=='photo')throw bad('Invalid album photo');if(i>0&&(item.caption!==undefined||item.caption_entities!==undefined))throw bad('Only first photo can carry caption');return {type:'photo',media:httpsPhoto(item.media),...(i===0?captionFields(item):{}),...(item.has_spoiler===true?{has_spoiler:true}:{})}})
    if(new Set(media.map(m=>m.media)).size!==media.length)throw bad('Duplicate album photo')
    const rows=await call({token,chatId,method:'sendMediaGroup',payload:{media},fetchImpl})
    const id=rows?.[0]?.media_group_id
    if(!Array.isArray(rows)||rows.length!==media.length||typeof id!=='string'||!id||rows.some(r=>!validId(r?.message_id)||r.media_group_id!==id||String(r.chat?.id)!==String(rows[0].chat?.id))||new Set(rows.map(r=>r.message_id)).size!==rows.length)throw new PromotionTelegramV2Error('Telegram album result incomplete',{uncertain:true})
    if(String(chatId).startsWith('-100')&&String(rows[0].chat?.id)!==String(chatId))throw new PromotionTelegramV2Error('Telegram album channel mismatch',{uncertain:true})
    return {messageId:rows[0].message_id,messageIds:rows.map(r=>r.message_id),mediaGroupId:id,fileId:null,chatId:String(rows[0].chat?.id??chatId)}
  }
  const payload={photo:fileId||httpsPhoto(message?.photo),...captionFields(message)}
  if(message.has_spoiler===true)payload.has_spoiler=true
  if(message.reply_markup?.inline_keyboard?.length)payload.reply_markup=message.reply_markup
  const row=await call({token,chatId,method:'sendPhoto',payload,fetchImpl})
  if(!validId(row?.message_id)||(String(chatId).startsWith('-100')&&String(row.chat?.id)!==String(chatId)))throw new PromotionTelegramV2Error('Telegram photo result incomplete',{uncertain:true})
  return {messageId:row.message_id,messageIds:[row.message_id],mediaGroupId:null,fileId:row.photo?.at(-1)?.file_id||null,chatId:String(row.chat?.id??chatId)}
}
export async function editPromotionCaptionV2({token,chatId,messageId,message,fetchImpl=globalThis.fetch}){
  if(!validId(messageId))throw bad('Invalid Telegram message ID')
  const payload={message_id:messageId,...captionFields(message)}
  if(message.reply_markup?.inline_keyboard?.length)payload.reply_markup=message.reply_markup
  const row=await call({token,chatId,method:'editMessageCaption',payload,fetchImpl,edit:true})
  if(row?.unchanged)return {messageId,unchanged:true}
  if(row?.message_id!==messageId||(String(chatId).startsWith('-100')&&String(row.chat?.id)!==String(chatId)))throw new PromotionTelegramV2Error('Telegram edit result incomplete',{uncertain:true})
  return {messageId,unchanged:false}
}
