import { PROMOTION_LANGUAGES } from './policy.service.js'

const optionalKinds = new Set(['completed','short','trending','author'])
const states = new Set(['ready','sending','sent','failed','uncertain','cancelled'])
const kinds = new Set(['update',...optionalKinds])
const settingsFields = 'language,enabled,channel_id,gap_seconds,schedule,links,next_send_at,enabled_at,updated_at'
const queueFields = 'id,language,kind,story_id,episode_id,author_id,payload,status,due_at,expires_at,attempts,sent_at,telegram_chat_id,telegram_message_id,last_error,created_at,updated_at'
export class PromotionAdminError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}
const bad = message => { throw new PromotionAdminError(message) }
const check = response => { if (response.error) throw new Error(`Promotion admin database: ${response.error.code || 'UNKNOWN'}`); return response.data }
export function requirePromotionLanguage(value) {
  if (typeof value !== 'string' || !Object.hasOwn(PROMOTION_LANGUAGES,value)) bad('Invalid language')
  return value
}
function httpsLink(value) {
  if (typeof value !== 'string' || value.length > 2000) bad('Invalid link')
  let url
  try { url = new URL(value) } catch { bad('Invalid link') }
  if (url.protocol !== 'https:' || url.username || url.password) bad('HTTPS link required')
  return url.href
}
export function validatePromotionSettings(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('Invalid settings')
  const allowed = new Set(['enabled','channel_id','gap_seconds','schedule','links','updated_at'])
  if (Object.keys(body).some(k=>!allowed.has(k))) bad('Unknown settings field')
  if (typeof body.updated_at !== 'string' || !Number.isFinite(Date.parse(body.updated_at))) bad('Settings version required')
  const patch = {}
  if (Object.hasOwn(body,'enabled')) {
    if (typeof body.enabled !== 'boolean') bad('Invalid enabled setting')
    patch.enabled = body.enabled
  }
  if (Object.hasOwn(body,'channel_id')) {
    if (body.channel_id !== null && (typeof body.channel_id !== 'string' || !/^-100\d{1,20}$/.test(body.channel_id))) bad('Invalid Telegram channel ID')
    patch.channel_id = body.channel_id
  }
  if (Object.hasOwn(body,'gap_seconds')) {
    if (!Number.isInteger(body.gap_seconds) || body.gap_seconds < 60 || body.gap_seconds > 3600) bad('Gap must be 60–3600 seconds')
    patch.gap_seconds = body.gap_seconds
  }
  if (Object.hasOwn(body,'schedule')) {
    if (!Array.isArray(body.schedule) || body.schedule.length > 42) bad('Invalid schedule')
    const seen = new Set()
    patch.schedule = body.schedule.map(s=>{
      if (!s || !Number.isInteger(s.day) || s.day < 0 || s.day > 6 || typeof s.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time) || !optionalKinds.has(s.kind)) bad('Invalid schedule slot')
      const key = `${s.day}:${s.time}`
      if (seen.has(key)) bad('Duplicate schedule slot')
      seen.add(key)
      return {day:s.day,time:s.time,kind:s.kind}
    })
  }
  if (Object.hasOwn(body,'links')) {
    const l = body.links
    if (!l || typeof l !== 'object' || Array.isArray(l) || Object.keys(l).sort().join(',') !== 'install,register,tutorial') bad('All three links required')
    patch.links = {register:httpsLink(l.register),install:httpsLink(l.install),tutorial:httpsLink(l.tutorial)}
  }
  if (!Object.keys(patch).length) bad('No settings changes')
  return {patch,version:body.updated_at}
}
export function buildSettingsUpdate(current, input, tokenConfigured, now = new Date().toISOString()) {
  const {patch,version} = validatePromotionSettings(input)
  if (Date.parse(current.updated_at) !== Date.parse(version)) throw new PromotionAdminError('Settings changed; reload first',409)
  const next = {...current,...patch}
  if (current.enabled_at && next.channel_id !== current.channel_id) throw new PromotionAdminError('Previously activated channel cannot be changed here',409)
  if (next.enabled && (!next.channel_id || !tokenConfigured)) bad('Configure channel and bot token before enabling')
  if (next.enabled && !current.enabled) patch.enabled_at = current.enabled_at || now
  return {...patch,updated_at:now}
}
export function parsePromotionQueueQuery(input) {
  const language = requirePromotionLanguage(input.language)
  const status = input.status || null, kind = input.kind || null
  if (status && !states.has(status)) bad('Invalid status')
  if (kind && !kinds.has(kind)) bad('Invalid promotion kind')
  const page = input.page === undefined ? 1 : Number(input.page)
  if (!Number.isInteger(page) || page < 1 || page > 1000) bad('Invalid page')
  return {language,status,kind,page}
}
export function createPromotionAdmin(db,{tokenConfigured=()=>false, runtimeEnabled=()=>false, wake=()=>false}={}) {
  const withConfig = row => ({...row,bot_configured:Boolean(tokenConfigured(row.language))})
  return {
    async settings() {
      const rows = check(await db.from('telegram_promotion_settings').select(settingsFields).order('language')) || []
      return {settings:rows.map(withConfig),runtime_enabled:Boolean(runtimeEnabled())}
    },
    async update(language,input) {
      requirePromotionLanguage(language)
      const current=check(await db.from('telegram_promotion_settings').select(settingsFields).eq('language',language).maybeSingle())
      if (!current) throw new PromotionAdminError('Settings not found',404)
      const patch=buildSettingsUpdate(current,input,tokenConfigured(language))
      const saved=check(await db.from('telegram_promotion_settings').update(patch).eq('language',language).eq('updated_at',current.updated_at).select(settingsFields).maybeSingle())
      if (!saved) throw new PromotionAdminError('Settings changed; reload first',409)
      wake()
      return withConfig(saved)
    },
    async list(input) {
      const {language,status,kind,page}=parsePromotionQueueQuery(input)
      let query=db.from('telegram_promotion_queue').select(queueFields).eq('language',language)
      if(status) query=query.eq('status',status)
      if(kind) query=query.eq('kind',kind)
      const from=(page-1)*10
      const rows=check(await query.order('created_at',{ascending:false}).order('id',{ascending:false}).range(from,from+10)) || []
      return {items:rows.slice(0,10),page,has_more:rows.length>10}
    },
    async cancel(id) {
      if(typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) bad('Invalid job ID')
      const row=check(await db.from('telegram_promotion_queue').update({status:'cancelled',last_error:'ADMIN_CANCELLED',updated_at:new Date().toISOString()}).eq('id',id).eq('status','ready').select(queueFields).maybeSingle())
      if(!row) throw new PromotionAdminError('Job is not ready or no longer exists',409)
      wake()
      return row
    },
  }
}
