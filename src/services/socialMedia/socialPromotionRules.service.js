const languages=new Set(['km','en','zh','ja','ko'])
const modes=new Set(['smart','stories','authors','mixed'])
const topics=new Set(['solo','update','gl','bl','romance','fantasy','comedy','trending','hidden','completed','short','new','night'])
const types=new Set(['novel','manga','chat_story'])
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const minute=/^([01]\d|2[0-3]):([0-5]\d)(?::00(?:\.0+)?)?$/
const localOffset=7*3600000
const slotGrace=15*60000
const dayMs=86400000

export function normalizeSocialId(value){
  if(typeof value!=='string'||!uuid.test(value))throw new TypeError('SOCIAL_RULE_ID_INVALID')
  return value.toLowerCase()
}
function uniqueList(value,max,parse){
  if(!Array.isArray(value)||value.length>max)throw new TypeError('SOCIAL_RULE_LIST_INVALID')
  return [...new Set(value.map(parse))].sort()
}
function parseTime(value){
  if(typeof value!=='string'||!minute.test(value))throw new TypeError('SOCIAL_RULE_TIME_INVALID')
  return value.slice(0,5)
}
function parseType(value){
  if(!types.has(value))throw new TypeError('SOCIAL_RULE_STORY_TYPE_INVALID')
  return value
}
export function normalizeSocialPromotionRule(input={}){
  const {connectionId,name,enabled=false,language,sourceTopic='solo',selectionMode='smart',storyIds=[],authorIds=[],storyTypes=[],dailyLimit=1,publishTimes=[]}=input
  if(Object.hasOwn(input,'contentMode')||Object.hasOwn(input,'postFormat')||Object.hasOwn(input,'content_mode')||Object.hasOwn(input,'post_format'))throw new TypeError('SOCIAL_RULE_FORMAT_AUTOMATIC')
  if(typeof name!=='string'||!name.trim()||name.trim().length>160||typeof enabled!=='boolean'||!languages.has(language)||!topics.has(sourceTopic)||!modes.has(selectionMode)||!Number.isInteger(dailyLimit)||dailyLimit<1||dailyLimit>100)throw new TypeError('SOCIAL_RULE_INVALID')
  const stories=uniqueList(storyIds,1000,normalizeSocialId),authors=uniqueList(authorIds,1000,normalizeSocialId),kinds=uniqueList(storyTypes,3,parseType),times=uniqueList(publishTimes,100,parseTime)
  const validScope=selectionMode==='smart'?stories.length===0&&authors.length===0:selectionMode==='stories'?authors.length===0&&(!enabled||stories.length>0):selectionMode==='authors'?stories.length===0&&(!enabled||authors.length>0):!enabled||stories.length+authors.length>0
  if(!validScope||(enabled&&!times.length))throw new TypeError('SOCIAL_RULE_SCOPE_INVALID')
  return {owner_type:'admin',owner_id:'shadow',connection_id:normalizeSocialId(connectionId),name:name.trim(),enabled,language,source_topic:sourceTopic,selection_mode:selectionMode,story_ids:stories,author_ids:authors,story_types:kinds,content_mode:'short',daily_limit:dailyLimit,publish_times:times.map(t=>`${t}:00`),timezone:'Asia/Phnom_Penh'}
}
export function dueSocialPromotionSlots(rule,now=Date.now()){
  if(!rule||rule.enabled!==true)return []
  if(rule.timezone!=='Asia/Phnom_Penh'||!Number.isFinite(now))throw new TypeError('SOCIAL_RULE_CLOCK_INVALID')
  const times=uniqueList(rule.publish_times,100,parseTime)
  const midnight=Math.floor((now+localOffset)/dayMs)*dayMs-localOffset
  const slots=[]
  for(const day of [midnight-dayMs,midnight])for(const time of times){
    const [h,m]=time.split(':').map(Number)
    const stamp=day+(h*60+m)*60000
    if(stamp<=now&&now-stamp<=slotGrace)slots.push(new Date(stamp).toISOString())
  }
  return slots
}
export function createSocialPromotionRules(db){
  if(!db?.from)throw new TypeError('SOCIAL_RULE_DB_REQUIRED')
  const fields='id,connection_id,name,enabled,language,source_topic,selection_mode,story_ids,author_ids,story_types,daily_limit,publish_times,timezone,created_at,updated_at'
  const scoped=()=>db.from('social_promotion_rules')
  return {
    async create(input){
      const {data,error}=await scoped().insert(normalizeSocialPromotionRule(input)).select(fields).single()
      if(error||!data)throw new Error('SOCIAL_RULE_CREATE_FAILED')
      return data
    },
    async replace(id,input,expectedRevision){
      if(typeof expectedRevision!=='string'||!Number.isFinite(Date.parse(expectedRevision)))throw new TypeError('SOCIAL_RULE_REVISION_INVALID')
      const row=normalizeSocialPromotionRule(input)
      const {data,error}=await scoped().update(row).eq('id',normalizeSocialId(id)).eq('owner_type','admin').eq('owner_id','shadow').eq('connection_id',row.connection_id).eq('updated_at',expectedRevision).select(fields).maybeSingle()
      if(error)throw new Error('SOCIAL_RULE_UPDATE_FAILED')
      if(!data)throw new Error('SOCIAL_RULE_STALE')
      return data
    }
  }
}
