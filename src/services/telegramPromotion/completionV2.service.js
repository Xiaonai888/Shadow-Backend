import { buildStoryPromotionV2 } from './messageV2.service.js'

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const safe=e=>String(e?.message||e||'Unknown').replace(/\b\d+:[A-Za-z0-9_-]{10,}\b/g,'[redacted]').slice(0,300)
function result(r){if(r?.error)throw new Error(`Promotion completion: ${safe(r.error.message)}`);return r?.data}
export function createPromotionCompletionV2({db,source,onError=()=>{}}){
  if(!db?.rpc||!source?.load||!source?.authorName)throw new TypeError('Missing completion dependencies')
  return {async run(settings){
    if(!settings?.enabled||!['km','en'].includes(settings.language))return {queued:0}
    const rows=result(await db.rpc('telegram_promotion_v2_completion_due',{p_language:settings.language}))
    if(!Array.isArray(rows)||rows.length>3)throw new TypeError('Invalid completion response')
    let queued=0
    for(const row of rows){
      try{
        if(!uuid.test(row.story_id||'')||!uuid.test(row.episode_id||'')||!Number.isFinite(Date.parse(row.completed_at)))throw new TypeError('Invalid completion event')
        const {story,episode}=await source.load(row.story_id,row.episode_id)
        if(!story||!episode||story.is_adult||episode.is_adult||String(story.story_status).toLowerCase()!=='completed'||story.status!=='published'||episode.status!=='published'||story.deleted_at||episode.deleted_at)continue
        const message=buildStoryPromotionV2({story,episode,language:settings.language,postType:'update',statusContext:{storyId:story.id,episodeId:episode.id,justCompleted:true},authorName:await source.authorName(story.author_id),links:settings.links,content:''})
        if(!message)continue
        const id=result(await db.rpc('telegram_promotion_v2_enqueue_completion',{p_language:settings.language,p_story_id:row.story_id,p_episode_id:row.episode_id,p_completed_at:row.completed_at,p_payload:message}))
        if(id)queued++
      }catch(error){try{onError({code:'PROMOTION_COMPLETION_FAILED',language:settings.language,story_id:row?.story_id||null,message:safe(error)})}catch{}}
    }
    return {queued}
  }}
}
