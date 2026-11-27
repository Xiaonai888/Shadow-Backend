import { EventAdminError, requireId, requireRevision, requireLanguage, validateSave, validateList, validateChannel } from './validation.service.js'
const eventFields='id,name,audience,status,schedule_mode,schedule_slots,starts_on,ends_on,next_publish_at,revision,created_at,updated_at'
const contentFields='language,enabled,message,image_url,image_key,button_label,button_url,updated_at'
const channelFields='language,channel_id,channel_name,enabled,updated_at'
const historyFields='id,event_id,language,channel_id,job_kind,scheduled_at,status,attempts,telegram_message_id,error_code,error_message,created_at,finished_at'
const errorMap={EVENT_NOT_FOUND:[404,'Event not found'],EVENT_CONFLICT:[409,'Event changed; reload first'],EVENT_INVALID_INPUT:[400,'Invalid event data'],EVENT_INVALID_STATUS:[400,'Invalid event status'],EVENT_INVALID_SCHEDULE:[400,'Invalid schedule'],EVENT_NO_FUTURE_SLOT:[400,'No future schedule'],EVENT_NO_ENABLED_CONTENT:[400,'Enable at least one language'],EVENT_CHANNEL_NOT_READY:[400,'Configure and enable channels first']}
function check(response) {
  if (!response.error) return response.data
  const code=String(response.error.message||'')
  if (Object.hasOwn(errorMap,code)) throw new EventAdminError(errorMap[code][1],errorMap[code][0],code)
  if (response.error.code==='23505') throw new EventAdminError('Duplicate record',409,'EVENT_DUPLICATE')
  if (['23514','23502','22P02','22007','22008'].includes(response.error.code)) throw new EventAdminError('Invalid event data',400)
  throw new Error(`Telegram event database: ${response.error.code||'UNKNOWN'}`)
}
export function createEventAdmin(db,{publicUrl,tokenConfigured=()=>false,runtimeEnabled=()=>false,wake=()=>{}}={}) {
  const notify=()=>{try { wake() } catch {}}
  async function detail(id) {
    const row=check(await db.from('telegram_events').select(`${eventFields},contents:telegram_event_contents(${contentFields})`).eq('id',requireId(id)).maybeSingle())
    if (!row || row.status==='archived') throw new EventAdminError('Event not found',404,'EVENT_NOT_FOUND')
    return row
  }
  async function persist(id,revision,event,contents) {
    const saved=check(await db.rpc('telegram_event_admin_save_v1',{p_id:id,p_revision:revision,p_event:event,p_contents:contents}))
    notify()
    return saved
  }
  const fromRow=(row,status)=>({name:row.name,audience:row.audience,status,schedule_mode:row.schedule_mode,schedule_slots:row.schedule_slots,starts_on:row.starts_on,ends_on:row.ends_on})
  return {
    async list(input) {
      const {language,audience,page}=validateList(input)
      let q=db.from('telegram_events').select(`${eventFields},contents:telegram_event_contents!inner(language,enabled,image_url,updated_at)`).eq('contents.language',language).neq('status','archived')
      if (audience!=='all') q=q.eq('audience',audience)
      const from=(page-1)*10
      const rows=check(await q.order('updated_at',{ascending:false}).order('id',{ascending:false}).range(from,from+10))||[]
      return {items:rows.slice(0,10),page,has_more:rows.length>10}
    },
    detail,
    async create(input) {
      const {event,contents}=validateSave(input,{publicUrl})
      if (input.revision!==undefined || !contents.length) throw new EventAdminError('New event requires at least one language')
      return {id:await persist(null,null,event,contents)}
    },
    async update(id,input) {
      const {event,contents}=validateSave(input,{publicUrl})
      return {id:await persist(requireId(id),requireRevision(input.revision),event,contents)}
    },
    async archive(id,revision) {
      const row=await detail(id)
      return {id:await persist(row.id,requireRevision(revision),fromRow(row,'archived'),[])}
    },
    async duplicate(id,revision) {
      const row=await detail(id)
      if (requireRevision(revision)!==Number(row.revision)) throw new EventAdminError('Event changed; reload first',409,'EVENT_CONFLICT')
      const event={...fromRow(row,'draft'),name:Array.from(row.name).slice(0,193).join('')+' (copy)'}
      const contents=row.contents.map(({language,message,image_url,image_key,button_label,button_url})=>({language,message,image_url,image_key,button_label,button_url,enabled:false}))
      return {id:await persist(null,null,event,contents)}
    },
    async channels() {
      const rows=check(await db.from('telegram_event_channels').select(channelFields).order('language'))||[]
      return {items:rows,bot_configured:Boolean(tokenConfigured()),runtime_enabled:Boolean(runtimeEnabled())}
    },
    async updateChannel(language,input) {
      requireLanguage(language)
      const {version,patch}=validateChannel(input)
      if (patch.enabled && !tokenConfigured()) throw new EventAdminError('Configure event bot before enabling channel')
      const row=check(await db.from('telegram_event_channels').update(patch).eq('language',language).eq('updated_at',version).select(channelFields).maybeSingle())
      if (!row) throw new EventAdminError('Channel settings changed; reload first',409,'EVENT_CONFLICT')
      notify()
      return row
    },
    async history(input) {
      const {language,page}=validateList({language:input.language,page:input.page})
      let q=db.from('telegram_event_history').select(historyFields).eq('language',language)
      if (input.event_id!==undefined) q=q.eq('event_id',requireId(input.event_id))
      if (input.status!==undefined && input.status!=='all') {
        if (!['pending','sending','retry','sent','failed','skipped','uncertain','cancelled'].includes(input.status)) throw new EventAdminError('Invalid history status')
        q=q.eq('status',input.status)
      }
      if (input.days!==undefined) {
        const days=Number(input.days)
        if (![1,7,30].includes(days)) throw new EventAdminError('Invalid history period')
        const today=new Date(Date.now()+7*3600000).toISOString().slice(0,10)
        const fromDate=new Date(Date.parse(`${today}T00:00:00+07:00`)-(days-1)*86400000).toISOString()
        q=q.gte('created_at',fromDate)
      }
      const from=(page-1)*10
      const rows=check(await q.order('created_at',{ascending:false}).order('id',{ascending:false}).range(from,from+10))||[]
      return {items:rows.slice(0,10),page,has_more:rows.length>10}
    }
  }
}
