import { normalizeSocialId } from './socialPromotionRules.service.js'

const offset=7*3600000
const localDay=stamp=>new Date(stamp+offset).toISOString().slice(0,10)
const languages=new Set(['km','en','zh','ja','ko'])
const kinds=new Set(['update','solo','group'])
export function createSocialPromotionPostLoader({freshSource,sharedSource,postContent,adaptPost,statusSource,clock=Date.now}){
  if(!freshSource?.fresh||!sharedSource?.mangaPages||!postContent?.build||typeof adaptPost!=='function'||!statusSource?.status||typeof clock!=='function')throw new TypeError('SOCIAL_LOADER_DEPENDENCIES')
  return async function loadPost({job,items,rule,platform}={}){
    const now=clock()
    if(!Number.isFinite(now)||!languages.has(job?.language)||!kinds.has(job?.post_kind)||!['facebook','instagram'].includes(platform)||rule?.id!==job.rule_id||rule?.language!==job.language||rule?.source_topic!==job.source_topic||rule?.updated_at!==job.rule_revision||!Array.isArray(items)||!Number.isFinite(Date.parse(job.scheduled_at)))return null
    const kind=job.post_kind,topic=job.source_topic
    if(kind==='group'?items.length<3||items.length>5||!job.caption_id:items.length!==1||job.caption_id!=null)return null
    const candidates=[]
    for(const [i,item] of items.entries()){
      if(item.position!==i+1)return null
      const storyId=normalizeSocialId(item.story_id),episodeId=normalizeSocialId(item.episode_id)
      const candidate=await freshSource.fresh({storyId,episodeId,topic,preview:kind!=='group'})
      if(!candidate||candidate.story.id!==storyId||candidate.episode.id!==episodeId)return null
      if(kind==='update'){
        const published=Date.parse(candidate.episode.first_published_at)
        if(!Number.isFinite(published)||localDay(published)!==localDay(Date.parse(job.scheduled_at)))return null
      }
      candidates.push(candidate)
    }
    const options={language:job.language,kind,topic:topic==='update'?'solo':topic,candidates,now,seed:`${job.scheduled_at.slice(0,10)}:${topic}`}
    if(kind==='group'){
      const excluded=[]
      for(let i=0;i<20;i++){
        const content=postContent.build({...options,captionHistory:excluded})
        if(!content||!content.captionId)return null
        if(content.captionId===job.caption_id)return adaptPost({platform,content})
        if(excluded.some(x=>x.captionId===content.captionId))return null
        excluded.push({language:job.language,captionId:content.captionId,status:'sent',sentAt:new Date(now).toISOString()})
      }
      return null
    }
    const {story,episode}=candidates[0]
    if(kind==='update')options.statusContext=await statusSource.status(story.id,episode.id)
    if(story.story_type==='manga'&&episode.is_free_published===true&&episode.is_locked===false)options.mangaPages=await sharedSource.mangaPages(episode.id)
    const content=postContent.build(options)
    return content?adaptPost({platform,content}):null
  }
}
