const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function createPromotionStatusSourceV2(db){
  if(!db?.rpc)throw new TypeError('Missing status database')
  return {async status(storyId,episodeId){
    if(!uuid.test(storyId||'')||!uuid.test(episodeId||''))throw new TypeError('Invalid story status IDs')
    const {data,error}=await db.rpc('telegram_promotion_v2_story_status',{p_story_id:storyId,p_episode_id:episodeId})
    if(error)throw new Error(`Promotion status: ${String(error.message||'Database error').slice(0,300)}`)
    if(data==null)return null
    if(data.storyId!==storyId||data.episodeId!==episodeId||typeof data.firstEpisode!=='boolean'||typeof data.justCompleted!=='boolean')throw new TypeError('Invalid status response')
    return data
  }}
}
