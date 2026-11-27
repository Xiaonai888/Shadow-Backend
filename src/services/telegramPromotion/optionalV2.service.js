import { planOptionalSlotV2 } from './scheduleV2.service.js'
import { buildGroupPromotionMessage } from './groupMessageV2.service.js'
import { storyTags } from './captionLibraryV2.service.js'
import { isRecommendationEligible,matchesRecommendationTopic,selectRecommendationGroup } from './recommendationV2.service.js'
const DAY=86400000
const localDay=now=>new Date(now+7*3600000).toISOString().slice(0,10)
const safe=v=>String(v||'Unknown').replace(/\b\d+:[A-Za-z0-9_-]{10,}\b/g,'[redacted]').slice(0,300)
function result(response){if(response?.error)throw new Error(`Promotion V2 schedule: ${safe(response.error.message)}`);return response?.data}
export function selectSoloV2({candidates,history=[],language,topic,now=Date.now(),similarTags=[],excludeId=null}){
  const last=new Map()
  for(const h of history){if(h.language!==language||!h.storyId)continue;const t=Date.parse(h.sentAt||h.updatedAt);const at=['ready','sending'].includes(h.status)?Infinity:['sent','uncertain'].includes(h.status)&&Number.isFinite(t)?t:-Infinity;last.set(String(h.storyId),Math.max(last.get(String(h.storyId))??-Infinity,at))}
  return candidates.filter(c=>{
    if(!isRecommendationEligible(c,{language,now})||!matchesRecommendationTopic(c,topic,now,similarTags)||String(c.story.id)===String(excludeId))return false
    const at=last.get(String(c.story.id))??-Infinity
    return at===-Infinity||Number.isFinite(at)&&at<=now-14*DAY&&localDay(at)!==localDay(now)&&localDay(at)!==localDay(now-DAY)
  }).sort((a,b)=>{
    if(topic==='trending')return Number(b.activity7)-Number(a.activity7)||String(a.story.id).localeCompare(String(b.story.id))
    if(topic==='hidden')return Number(a.story.total_views)-Number(b.story.total_views)||String(a.story.id).localeCompare(String(b.story.id))
    const x=last.get(String(a.story.id))??-Infinity,y=last.get(String(b.story.id))??-Infinity
    return (x===y?0:x<y?-1:1)||String(a.story.id).localeCompare(String(b.story.id))
  })
}
export function createPromotionOptionalV2({db,source,storySource,queue,messageBuilder}){
  if(!db?.rpc||!source?.candidates||!storySource?.load||!queue?.enqueueOptional||!messageBuilder?.build)throw new TypeError('Missing V2 optional dependencies')
  return {async enqueue({settings,slot,now=Date.now()}){
    const language=settings?.language
    if(!settings?.enabled||!['km','en'].includes(language)||!slot||slot.dueAt>now||slot.expiresAt<=now)return null
    const stats=result(await db.rpc('telegram_promotion_v2_slot_context',{p_language:language,p_slot:slot.slotKey}))
    if(!stats||!Number.isSafeInteger(stats.updateCount)||!Number.isSafeInteger(stats.daytimeCount)||!Array.isArray(stats.recentTopics))throw new TypeError('Invalid slot context')
    const similarTags=storyTags({main_genre:stats.similarStory?.main_genre,tags:stats.similarStory?.tags})
    const plan=planOptionalSlotV2({slot,language,stats:{...stats,similarTags}})
    if(plan.existingId)return plan.existingId
    for(const p of plan.plans){
      const seed=`${slot.slotKey}:${p.topic}`
      const data=await source.candidates({language,topic:p.topic,seed,similarTags,now,count:p.count,maxPages:3})
      const candidates=data.candidates.filter(c=>p.topic!=='similar'||c.story.id!==stats.similarStory?.id)
      const selected=selectRecommendationGroup({candidates,language,topic:p.topic,history:data.history,now,count:p.count,seed,similarTags})
      if(p.postType==='group'&&selected.stories.length>=3){
        const message=buildGroupPromotionMessage({candidates:selected.stories,topic:p.topic,language,history:data.captionHistory,now,seed,similarTags})
        if(message&&new Set(message.media.map(m=>m.media)).size===message.media.length){
          const id=await queue.enqueueOptional({language,slot,postType:'group',topic:p.topic,captionId:message.captionId,candidates:selected.stories,message,cooldownDays:selected.cooldownDays})
          if(id)return id
        }
      }
      if(p.topic==='night')continue
      const solos=selectSoloV2({candidates,history:data.history,language,topic:p.topic,now,similarTags,excludeId:p.topic==='similar'?stats.similarStory?.id:null})
      for(const c of solos.slice(0,2)){
        const loaded=await storySource.load(c.story.id,c.episode.id)
        if(!loaded?.story||!loaded?.episode)continue
        const fresh={...c,story:{...c.story,...loaded.story},episode:{...loaded.episode,first_published_at:loaded.episode.first_published_at||loaded.episode.published_at}}
        if(!isRecommendationEligible(fresh,{language,now})||!matchesRecommendationTopic(fresh,p.topic,now,similarTags))continue
        const message=await messageBuilder.build({...fresh,language,postType:'solo',topic:p.topic,links:settings.links})
        if(!message)continue
        const id=await queue.enqueueOptional({language,slot,postType:'solo',topic:p.topic,candidates:[fresh],message,cooldownDays:14})
        if(id)return id
      }
    }
    return null
  }}
}
