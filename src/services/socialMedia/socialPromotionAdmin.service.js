import { normalizeSocialId, normalizeSocialPromotionRule } from './socialPromotionRules.service.js'
import { connectionFields, safeConnection, SocialAdminError } from './socialPromotionConnectionStore.service.js'

const ruleFields='id,connection_id,name,enabled,language,source_topic,selection_mode,story_ids,author_ids,story_types,daily_limit,publish_times,timezone,created_at,updated_at'
const jobFields='id,connection_id,rule_id,story_id,episode_id,language,post_kind,source_topic,status,scheduled_at,started_at,finished_at,external_post_id,error_code,created_at,social_media_job_items(position,story_id,episode_id)'
const states=new Set(['queued','publishing','published','failed','needs_review','cancelled'])
const platforms=new Set(['facebook','instagram','threads'])
function pageNumber(value=1){
  if(!/^[1-9]\d{0,3}$/.test(String(value)))throw new SocialAdminError('SOCIAL_ADMIN_PAGE_INVALID')
  return Number(value)
}
function pick(row,fields){return Object.fromEntries(fields.split(',').map(k=>[k,row[k]]))}
function safeJob(row){
  const item=pick(row,jobFields.split(',social_media_job_items')[0])
  return {...item,items:(row.social_media_job_items||[]).map(x=>pick(x,'position,story_id,episode_id')).sort((a,b)=>a.position-b.position)}
}
export function createSocialPromotionAdmin({db,rules,clock=Date.now}={}){
  if(!db?.from||!rules?.create||!rules?.replace||typeof clock!=='function')throw new TypeError('SOCIAL_ADMIN_DEPENDENCIES')
  const scope=q=>q.eq('owner_type','admin').eq('owner_id','shadow')
  async function list(table,fields,query,sort,filter,project){
    const page=pageNumber(query.page),size=10,start=(page-1)*size
    let q=scope(db.from(table).select(fields)).order(sort,{ascending:false}).order('id',{ascending:false})
    q=filter(q)
    const {data,error}=await q.range(start,start+size)
    if(error||!Array.isArray(data))throw new SocialAdminError('SOCIAL_ADMIN_LIST_FAILED',500)
    return {items:data.slice(0,size).map(project),page,pageSize:size,hasMore:data.length>size}
  }
  async function checkRule(input){
    const row=normalizeSocialPromotionRule(input)
    if(row.daily_limit>3||row.publish_times.length>3)throw new SocialAdminError('SOCIAL_RULE_DAILY_LIMIT_MAX_3')
    const {data,error}=await scope(db.from('social_media_connections').select('id,status,platform,token_expires_at')).eq('id',row.connection_id).maybeSingle()
    if(error)throw new SocialAdminError('SOCIAL_CONNECTION_READ_FAILED',500)
    if(!data||!platforms.has(data.platform))throw new SocialAdminError('SOCIAL_CONNECTION_NOT_FOUND',404)
    if(row.enabled&&(data.status!=='connected'||(data.token_expires_at&&Date.parse(data.token_expires_at)<=clock())))throw new SocialAdminError('SOCIAL_CONNECTION_NOT_ACTIVE',409)
    if(row.enabled){
      const {data:assignment,error:assignmentError}=await scope(db.from('social_media_bot_assignments').select('connection_id')).eq('connection_id',row.connection_id).eq('bot_key','promotion').maybeSingle()
      if(assignmentError)throw new SocialAdminError('SOCIAL_BOT_DATABASE_FAILED',503)
      if(!assignment)throw new SocialAdminError('SOCIAL_BOT_ASSIGNMENT_REQUIRED',409)
    }
  }
  return {
    listConnections(query={}){
      if(query.platform&&!platforms.has(query.platform))throw new SocialAdminError('SOCIAL_PLATFORM_INVALID')
      return list('social_media_connections',connectionFields,query,'created_at',q=>query.platform?q.eq('platform',query.platform):q,safeConnection)
    },
    listRules(query={}){
      const id=query.connectionId?normalizeSocialId(query.connectionId):null
      return list('social_promotion_rules',ruleFields,query,'created_at',q=>id?q.eq('connection_id',id):q,row=>pick(row,ruleFields))
    },
    listJobs(query={}){
      const id=query.connectionId?normalizeSocialId(query.connectionId):null
      if(query.status&&!states.has(query.status))throw new SocialAdminError('SOCIAL_JOB_STATUS_INVALID')
      return list('social_media_jobs',jobFields,query,'scheduled_at',q=>{if(id)q=q.eq('connection_id',id);if(query.status)q=q.eq('status',query.status);return q},safeJob)
    },
    async createRule(input){await checkRule(input);return pick(await rules.create(input),ruleFields)},
    async replaceRule(id,input,revision){
      await checkRule(input)
      try{return pick(await rules.replace(id,input,revision),ruleFields)}catch(error){if(error?.message==='SOCIAL_RULE_STALE')throw new SocialAdminError('SOCIAL_RULE_STALE',409);throw error}
    },
    async cancelJob(id){
      const {data,error}=await scope(db.from('social_media_jobs').update({status:'cancelled',finished_at:new Date(clock()).toISOString(),error_code:'SOCIAL_ADMIN_CANCELLED'})).eq('id',normalizeSocialId(id)).eq('status','queued').select(jobFields).maybeSingle()
      if(error)throw new SocialAdminError('SOCIAL_JOB_CANCEL_FAILED',500)
      if(!data)throw new SocialAdminError('SOCIAL_JOB_NOT_QUEUED',409)
      return safeJob(data)
    }
  }
}
