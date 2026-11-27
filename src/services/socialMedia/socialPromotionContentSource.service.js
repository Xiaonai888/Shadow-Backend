import { normalizeSocialId } from './socialPromotionRules.service.js'

const topics=new Set(['solo','update','gl','bl','romance','fantasy','comedy','trending','hidden','completed','short','new','night'])
const validDate=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))
export function createSocialPromotionContentSource(db){
  if(!db?.rpc)throw new TypeError('SOCIAL_CONTENT_DB_REQUIRED')
  async function call(name,args){
    const {data,error}=await db.rpc(name,args)
    if(error)throw new Error('SOCIAL_CONTENT_SOURCE_FAILED')
    return data
  }
  return {
    async candidates({rule,slot,limit=30}={}){
      if(rule?.owner_type!=='admin'||rule.owner_id!=='shadow'||rule.source_topic!=='update'||!validDate(rule.updated_at)||!validDate(slot)||!Number.isInteger(limit)||limit<1||limit>30)throw new TypeError('SOCIAL_UPDATE_SOURCE_INVALID')
      const rows=await call('social_promotion_updates_v4',{p_rule_id:normalizeSocialId(rule.id),p_revision:rule.updated_at,p_slot:slot,p_limit:limit})
      if(!Array.isArray(rows)||rows.length>limit)throw new Error('SOCIAL_UPDATE_SOURCE_RESPONSE')
      const ids=new Set()
      for(const c of rows){
        normalizeSocialId(c?.story?.id)
        const id=normalizeSocialId(c?.episode?.id)
        if(ids.has(id))throw new Error('SOCIAL_UPDATE_SOURCE_RESPONSE')
        ids.add(id)
      }
      return rows
    },
    async fresh({storyId,episodeId,topic,preview=false}={}){
      const story=normalizeSocialId(storyId),episode=normalizeSocialId(episodeId)
      if(!topics.has(topic)||typeof preview!=='boolean')throw new TypeError('SOCIAL_FRESH_SOURCE_INVALID')
      const row=await call('social_promotion_fresh_candidate_v4',{p_story_id:story,p_episode_id:episode,p_topic:topic,p_preview:preview})
      if(row===null)return null
      if(row?.story?.id!==story||row?.episode?.id!==episode||row.episode.story_id!==story||!Number.isInteger(row.publishedEpisodeCount)||row.publishedEpisodeCount<5||typeof row.episode.is_free_published!=='boolean'||typeof row.episode.is_locked!=='boolean'||row.episode.is_free_published===row.episode.is_locked)throw new Error('SOCIAL_FRESH_SOURCE_RESPONSE')
      if((!preview||!row.episode.is_free_published)&&(row.episode.content!=null||row.episode.is_free_published))throw new Error('SOCIAL_FRESH_PREVIEW_ISOLATION')
      return row
    }
  }
}
