import { GROUP_TOPICS } from './captionLibraryV2.service.js'
import { isRecommendationEligible, matchesRecommendationTopic, selectRecommendationGroup } from './recommendationV2.service.js'
import { selectMangaPreview } from './mangaPreviewV2.service.js'

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const topics=new Set([...GROUP_TOPICS,'solo'])
const safe=v=>String(v||'Unknown').replace(/\b\d+:[A-Za-z0-9_-]{10,}\b/g,'[redacted]').slice(0,300)
function result(response){if(response?.error)throw new Error(`Promotion V2 source: ${safe(response.error.message)}`);return response?.data}
const localDay=now=>new Date(now+7*3600000).toISOString().slice(0,10)
function mapHistory(row){return {language:row.language,storyId:row.story_id,status:row.status,sentAt:row.sent_at,updatedAt:row.updated_at}}
function mapCaption(row,now){return {language:row.language,topic:row.topic,captionId:row.caption_id,status:row.status,sentAt:['ready','sending'].includes(row.status)?new Date(now).toISOString():row.sent_at||row.updated_at}}
export function createPromotionSourceV2(db){
  if(!db?.rpc)throw new TypeError('Missing Supabase client')
  return {
    async candidates({language,topic,seed,similarTags=[],now=Date.now(),count=topic==='night'?3:5,maxPages=3}){
      if(!['km','en'].includes(language)||!topics.has(topic)||!Number.isFinite(now)||!Number.isInteger(maxPages)||maxPages<1||maxPages>10||!Number.isInteger(count)||count<3||count>5)throw new TypeError('Invalid V2 candidate request')
      const key=String(seed??localDay(now));if(!key||key.length>100)throw new TypeError('Invalid V2 seed')
      const candidates=new Map(),history=new Map(),captions=new Map()
      let pages=0,exhausted=false,selection=null
      for(let i=0;i<maxPages;i++){
        const data=result(await db.rpc('telegram_promotion_v2_candidate_page',{p_language:language,p_topic:topic,p_seed:key,p_offset:i*100}))
        if(!data||!Number.isInteger(data.scanned)||data.scanned<0||data.scanned>100||!Array.isArray(data.candidates)||!Array.isArray(data.history)||!Array.isArray(data.captions))throw new TypeError('Invalid V2 candidate response')
        pages++
        for(const c of data.candidates){if(isRecommendationEligible(c,{language,now})&&(topic==='solo'||matchesRecommendationTopic(c,topic,now,similarTags)))candidates.set(String(c.story.id),c)}
        for(const h of data.history){if(h.language===language&&h.story_id)history.set(String(h.story_id),mapHistory(h))}
        for(const h of data.captions){if(h.language===language&&h.caption_id)captions.set(h.caption_id,mapCaption(h,now))}
        exhausted=data.scanned<100
        if(topic!=='solo')selection=selectRecommendationGroup({candidates:[...candidates.values()],history:[...history.values()],language,topic,now,count,seed:key,similarTags})
        if(exhausted||(topic!=='solo'&&selection?.stories.length>=(topic==='night'?3:count)&&selection.cooldownDays===14)||(topic==='solo'&&candidates.size>=30))break
      }
      return {candidates:[...candidates.values()],history:[...history.values()],captionHistory:[...captions.values()],selection,pages,exhausted}
    },
    async mangaPreview(episodeId){
      if(!uuid.test(String(episodeId||'')))throw new TypeError('Invalid episode ID')
      const rows=result(await db.rpc('telegram_promotion_v2_manga_pages',{p_episode_id:episodeId}))
      if(!Array.isArray(rows))throw new TypeError('Invalid Manga page response')
      return selectMangaPreview(rows)
    }
  }
}
