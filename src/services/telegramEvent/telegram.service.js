export class EventTelegramError extends Error {
  constructor(message,{status=null,code=null,retryAfter=null,uncertain=false}={}) {
    super(message)
    this.name='EventTelegramError'
    Object.assign(this,{status,code,retryAfter,uncertain})
  }
}
const invalid=message=>new EventTelegramError(message,{status:400,code:'INVALID_PAYLOAD'})
const https=value=>{
  try {const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&typeof value==='string'&&value.length<=2048} catch {return false}
}
export function buildEventTelegramPayload(job,fileId=null) {
  if (!job || typeof job.channel_id!=='string' || !/^-100\d{5,17}$/.test(job.channel_id)) throw invalid('Invalid event channel')
  const message=job.message
  const photo=Boolean(job.image_url)
  if (typeof message!=='string'||Array.from(message).length>(photo?1000:4000)||(!photo&&!message.trim())) throw invalid('Invalid event message')
  if (photo&&!https(job.image_url)) throw invalid('Invalid event image URL')
  if (fileId!==null&&(typeof fileId!=='string'||!fileId.trim()||fileId.length>1024)) throw invalid('Invalid cached photo')
  const payload={chat_id:job.channel_id}
  if(photo) {payload.photo=fileId||job.image_url;if(message)payload.caption=message}
  else {payload.text=message;payload.link_preview_options={is_disabled:true}}
  if(job.button_label!=null||job.button_url!=null) {
    if(typeof job.button_label!=='string'||!job.button_label.trim()||Array.from(job.button_label).length>64||!https(job.button_url))throw invalid('Invalid event button')
    payload.reply_markup={inline_keyboard:[[{text:job.button_label,url:job.button_url}]]}
  }
  return {method:photo?'sendPhoto':'sendMessage',payload}
}
export async function sendEventTelegram({token,job,fileId=null,fetchImpl=globalThis.fetch}) {
  const secret=String(token||'').trim()
  if(!/^\d+:[A-Za-z0-9_-]+$/.test(secret)) throw invalid('Invalid event bot token')
  const {method,payload}=buildEventTelegramPayload(job,fileId)
  const controller=new AbortController()
  const timer=setTimeout(()=>controller.abort(),15000)
  try {
    let response,data
    try {
      response=await fetchImpl(`https://api.telegram.org/bot${secret}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:controller.signal,redirect:'error'})
      data=await response.json()
    } catch {throw new EventTelegramError('Telegram delivery result unknown',{uncertain:true})}
    if (!response.ok||data?.ok!==true) {
      const status=Number(data?.error_code||response.status)||null
      const confirmed=data?.ok===false&&Number.isInteger(status)&&status>=400&&status<500
      const description=typeof data?.description==='string'?data.description:''
      const badCache=confirmed&&status===400&&fileId&&/wrong file identifier|wrong remote file identifier|invalid file[_ ]id|file reference expired|file_id is invalid/i.test(description)
      const delay=Number(data?.parameters?.retry_after)
      throw new EventTelegramError(`Telegram ${method} rejected (${status??'unknown'})`,{status,code:badCache?'INVALID_FILE_ID':null,retryAfter:Number.isFinite(delay)&&delay>0?delay:null,uncertain:!confirmed})
    }
    const result=data.result
    if(!Number.isSafeInteger(result?.message_id)||result.message_id<=0||String(result.chat?.id)!==job.channel_id) throw new EventTelegramError('Telegram delivery confirmation invalid',{uncertain:true})
    const image=Array.isArray(result.photo)?result.photo.at(-1):null
    return {messageId:result.message_id,fileId:photoId(image)}
  } finally {clearTimeout(timer)}
}
function photoId(photo) {return typeof photo?.file_id==='string'&&photo.file_id.length>0&&photo.file_id.length<=1024?photo.file_id:null}
