import { normalizeSocialId } from './socialPromotionRules.service.js'

const languages=new Set(['km','en','zh','ja','ko'])
function scope(rule){
  if(!rule||rule.owner_type!=='admin'||rule.owner_id!=='shadow'||!languages.has(rule.language)||!['smart','stories','authors','mixed'].includes(rule.selection_mode))throw new TypeError('SOCIAL_PLANNER_RULE_INVALID')
  const storyIds=rule.story_ids.map(normalizeSocialId),authorIds=rule.author_ids.map(normalizeSocialId)
  if(rule.selection_mode==='stories'&&(!storyIds.length||authorIds.length)||rule.selection_mode==='authors'&&(!authorIds.length||storyIds.length)||rule.selection_mode==='mixed'&&!storyIds.length&&!authorIds.length||rule.selection_mode==='smart'&&(storyIds.length||authorIds.length))throw new TypeError('SOCIAL_PLANNER_SCOPE_INVALID')
  return {storyIds,authorIds,storyTypes:rule.story_types}
}
export function createSocialPromotionPlanner({source,selection,chooseCaption,queue,updateSource}){
  if(!source?.candidatePage||!selection?.group||!selection?.solo||typeof chooseCaption!=='function'||!queue?.history||!queue?.enqueue||typeof updateSource?.candidates!=='function')throw new TypeError('SOCIAL_PLANNER_DEPENDENCIES')
  return {async plan({rule,slot,now=Date.now()}){
    if(rule?.enabled!==true)return {state:'disabled'}
    const filters=scope(rule),language=rule.language,topic=rule.source_topic,seed=`${slot.slice(0,10)}:${topic}`
    const all=new Map()
    if(topic==='update'){
      const rows=await updateSource.candidates({rule,slot,now,limit:30})
      if(!Array.isArray(rows)||rows.length>30)throw new Error('SOCIAL_PLANNER_UPDATE_RESPONSE')
      for(const c of rows){if(c?.story?.id&&c?.episode?.id)all.set(c.episode.id,c)}
    }else{
      for(let offset=0;offset<300;offset+=100){
        const page=await source.candidatePage({language,topic,seed,offset,historyScope:'neutral',...filters})
        for(const c of page.candidates){if(c?.story?.id&&c?.episode?.id)all.set(c.story.id,c)}
        if(page.scanned<100)break
      }
    }
    const candidates=[...all.values()]
    if(!candidates.length)return {state:'empty'}
    const {history,captionHistory}=await queue.history({connectionId:rule.connection_id,language,storyIds:[...new Set(candidates.map(c=>c.story.id))]})
    const enqueue=(kind,rows,captionId=null)=>queue.enqueue({ruleId:rule.id,revision:rule.updated_at,slot,kind,items:rows.map(c=>({storyId:c.story.id,episodeId:c.episode.id})),captionId})
    if(topic==='update'){
      for(const c of candidates.slice(0,5)){
        const result=await enqueue('update',[c]);if(!['duplicate','ineligible'].includes(result.state))return result
      }
      return {state:'empty'}
    }
    const options={candidates,history,language,topic,now,seed}
    if(topic!=='solo'){
      const {stories}=selection.group({...options,count:topic==='night'?3:5})
      if(stories.length>=3&&new Set(stories.map(c=>c.story.cover_url)).size===stories.length){
        const caption=chooseCaption({topic,language,stories:stories.map(c=>c.story),history:captionHistory,now,seed})
        if(caption){const result=await enqueue('group',stories,caption.captionId);if(!['duplicate','duplicate_caption','ineligible'].includes(result.state))return result}
      }
      if(topic==='night')return {state:'empty'}
    }
    for(const c of selection.solo(options).slice(0,5)){
      const result=await enqueue('solo',[c]);if(!['duplicate','ineligible'].includes(result.state))return result
    }
    return {state:'empty'}
  }}
}
