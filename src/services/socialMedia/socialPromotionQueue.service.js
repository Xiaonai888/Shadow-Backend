import {normalizeSocialId} from './socialPromotionRules.service.js'

const languages=new Set(['km','en','zh','ja','ko'])
const kinds=new Set(['solo','group','update'])
const states=new Set(['queued','existing','invalid','disabled','stale_rule','invalid_slot','daily_limit','ineligible','duplicate','duplicate_caption'])
const historyStatuses=new Set(['ready','sending','sent'])
function date(value,code){
  if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))throw new TypeError(code)
  return value
}
function listItems(items,kind){
  if(!Array.isArray(items)||(kind==='group'?items.length<3||items.length>5:items.length!==1))throw new TypeError('SOCIAL_QUEUE_ITEMS_INVALID')
  const rows=items.map(i=>({story_id:normalizeSocialId(i?.storyId),episode_id:normalizeSocialId(i?.episodeId)}))
  if(new Set(rows.map(i=>i.story_id)).size!==rows.length||new Set(rows.map(i=>i.episode_id)).size!==rows.length)throw new TypeError('SOCIAL_QUEUE_DUPLICATE_ITEMS')
  return rows
}
export function createSocialPromotionQueue(db){
  if(!db?.rpc)throw new TypeError('SOCIAL_QUEUE_DB_REQUIRED')
  return {
    async enqueue({ruleId,revision,slot,kind,items,captionId=null}={}){
      if(!kinds.has(kind)||(captionId!==null&&(typeof captionId!=='string'||!captionId.trim()||captionId.length>160)))throw new TypeError('SOCIAL_QUEUE_INVALID')
      const time=date(slot,'SOCIAL_QUEUE_SLOT_INVALID')
      if(Date.parse(time)%60000!==0)throw new TypeError('SOCIAL_QUEUE_SLOT_INVALID')
      const {data,error}=await db.rpc('social_promotion_enqueue_v2',{p_rule_id:normalizeSocialId(ruleId),p_revision:date(revision,'SOCIAL_QUEUE_REVISION_INVALID'),p_slot:time,p_kind:kind,p_items:listItems(items,kind),p_caption_id:captionId})
      if(error?.code==='23514'&&error.message==='SOCIAL_EXCEPTION_BLOCKED')return {state:'ineligible'}
      if(error?.code==='23514'&&error.message==='SOCIAL_ACCOUNT_DAILY_LIMIT')return {state:'daily_limit'}
      if(error||!data||!states.has(data.state))throw new Error('SOCIAL_QUEUE_ENQUEUE_FAILED')
      if(['queued','existing'].includes(data.state))return {state:data.state,jobId:normalizeSocialId(data.jobId)}
      return {state:data.state}
    },
    async history({connectionId,language,storyIds=[]}={}){
      if(!languages.has(language)||!Array.isArray(storyIds)||storyIds.length>1000)throw new TypeError('SOCIAL_HISTORY_INVALID')
      const ids=[...new Set(storyIds.map(normalizeSocialId))].sort()
      const {data,error}=await db.rpc('social_promotion_history_v2',{p_connection_id:normalizeSocialId(connectionId),p_language:language,p_story_ids:ids})
      if(error||!data||!Array.isArray(data.history)||data.history.length>ids.length||!Array.isArray(data.captionHistory)||data.history.some(h=>h.language!==language||!ids.includes(h.storyId)||!historyStatuses.has(h.status))||data.captionHistory.some(h=>h.language!==language||!historyStatuses.has(h.status)||typeof h.captionId!=='string'))throw new Error('SOCIAL_HISTORY_FAILED')
      return {history:data.history,captionHistory:data.captionHistory}
    }
  }
}
