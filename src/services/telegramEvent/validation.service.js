export const EVENT_LANGUAGES = Object.freeze(['km','en','zh','ko','ja'])
export class EventAdminError extends Error {
  constructor(message,status=400,code='EVENT_INVALID_INPUT') { super(message); this.status=status; this.code=code }
}
const bad = message => { throw new EventAdminError(message) }
const record = (v,keys) => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k=>!keys.includes(k))) bad('Invalid or unknown fields')
  return v
}
const length = v => Array.from(v).length
const text = (v,max,required=false) => {
  if (typeof v !== 'string' || length(v)>max || (required && !v.trim())) bad('Invalid text')
  return v
}
export function requireLanguage(v) { if (!EVENT_LANGUAGES.includes(v)) bad('Invalid language'); return v }
export function requireId(v) { if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) bad('Invalid event ID'); return v.toLowerCase() }
export function requireRevision(v) { if (!Number.isSafeInteger(v) || v<1) bad('Revision required'); return v }
const validDate = v => {
  if (typeof v !== 'string' || !/^[2-9]\d{3}-\d{2}-\d{2}$/.test(v)) bad('Invalid date')
  const d=new Date(`${v}T00:00:00Z`)
  if (!Number.isFinite(+d) || d.toISOString().slice(0,10)!==v) bad('Invalid date')
  return v
}
const https = v => {
  text(v,2048,true)
  let u
  try { u=new URL(v) } catch { bad('Invalid URL') }
  if (u.protocol!=='https:' || u.username || u.password || /\s/.test(v) || u.href.length>2048) bad('HTTPS URL required')
  return u.href
}
export function validateSchedule(input,status) {
  const mode=input.schedule_mode
  if (!['weekly','biweekly','dates'].includes(mode) || !Array.isArray(input.schedule_slots) || input.schedule_slots.length>100) bad('Invalid schedule')
  const start=input.starts_on??null, end=input.ends_on??null
  if (!input.schedule_slots.length && status==='draft' && start===null && end===null) return {schedule_mode:mode,schedule_slots:[],starts_on:null,ends_on:null}
  if (!input.schedule_slots.length) bad('Add at least one schedule')
  if (mode!=='dates') { validDate(start); if (end!==null && validDate(end)<start) bad('End date precedes start date') }
  else if (start!==null || end!==null) bad('Specific dates do not use start/end dates')
  const seen=new Set()
  const slots=input.schedule_slots.map(s=>{
    record(s,mode!=='dates'?['day','time']:['date','time'])
    if (typeof s.time!=='string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s.time)) bad('Invalid time')
    if (mode!=='dates' && (!Number.isInteger(s.day) || s.day<0 || s.day>6)) bad('Invalid weekday')
    const first=mode!=='dates'?s.day:validDate(s.date)
    const key=`${first}T${s.time}`
    if (seen.has(key)) bad('Duplicate schedule')
    seen.add(key)
    return mode!=='dates'?{day:first,time:s.time}:{date:first,time:s.time}
  }).sort((a,b)=>mode!=='dates'?(a.day-b.day||a.time.localeCompare(b.time)):(a.date.localeCompare(b.date)||a.time.localeCompare(b.time)))
  return {schedule_mode:mode,schedule_slots:slots,starts_on:start,ends_on:end}
}
export function validateContent(input,{publicUrl}={}) {
  record(input,['language','enabled','message','image_url','image_key','button_label','button_url'])
  const language=requireLanguage(input.language)
  if (typeof input.enabled!=='boolean') bad('Invalid content status')
  const image_key=input.image_key??null, image_url=input.image_url??null
  if ((image_key===null)!==(image_url===null)) bad('Image upload is incomplete')
  if (image_key!==null) {
    if (typeof image_key!=='string' || !/^telegram-events\/images\/[A-Za-z0-9_-]{1,128}\/\d+-[a-f0-9-]{36}\.(?:jpg|png|webp)$/.test(image_key)) bad('Invalid event image key')
    const base=String(publicUrl||'').trim().replace(/\/+$/,'')
    if (!base || https(image_url)!==`${base}/${image_key}`) bad('Invalid Cloudflare image URL')
  }
  const message=text(input.message,image_url?1000:4000)
  if (input.enabled && !message.trim() && !image_url) bad('Add message or image before enabling language')
  let button_label=input.button_label??null,button_url=input.button_url??null
  if ((button_label===null)!==(button_url===null)) bad('Button label and URL must be provided together')
  if (button_label!==null) { button_label=text(button_label,64,true).trim(); button_url=https(button_url) }
  return {language,enabled:input.enabled,message,image_key,image_url,button_label,button_url}
}
export function validateSave(input,options={}) {
  record(input,['name','audience','status','schedule_mode','schedule_slots','starts_on','ends_on','contents','revision'])
  const name=text(input.name,200,true).trim()
  if (!['reader','author'].includes(input.audience)) bad('Invalid event type')
  if (!['draft','active','paused'].includes(input.status)) bad('Invalid event status')
  const schedule=validateSchedule(input,input.status)
  if (!Array.isArray(input.contents)||input.contents.length>5) bad('Invalid language contents')
  const contents=input.contents.map(c=>validateContent(c,options))
  if (new Set(contents.map(c=>c.language)).size!==contents.length) bad('Duplicate language')
  return {event:{name,audience:input.audience,status:input.status,...schedule},contents}
}
export function validateList(input) {
  const language=requireLanguage(input.language)
  const audience=input.audience??'all'
  if (!['all','reader','author'].includes(audience)) bad('Invalid audience filter')
  const page=input.page===undefined?1:Number(input.page)
  if (!Number.isInteger(page)||page<1||page>1000) bad('Invalid page')
  return {language,audience,page}
}
export function validateChannel(input) {
  record(input,['channel_id','channel_name','enabled','updated_at'])
  if (typeof input.updated_at!=='string'||!Number.isFinite(Date.parse(input.updated_at))) bad('Channel version required')
  if (typeof input.enabled!=='boolean') bad('Invalid channel status')
  const channel_id=input.channel_id??null
  if (channel_id!==null && (typeof channel_id!=='string'||!/^-100\d{5,17}$/.test(channel_id))) bad('Numeric Telegram channel ID required')
  if (input.enabled && !channel_id) bad('Channel ID required')
  return {version:input.updated_at,patch:{channel_id,channel_name:input.channel_name==null?null:text(input.channel_name,200).trim(),enabled:input.enabled}}
}
