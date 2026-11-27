import { createCandidateCache } from './candidateCache.service.js'

const languages=new Set(['km','en','zh','ja','ko'])
const topics=new Set(['gl','bl','romance','fantasy','comedy','trending','hidden','completed','short','new','similar','night','solo'])
const types=new Set(['novel','manga','chat_story'])
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function list(value,limit,validate){
  if(!Array.isArray(value)||value.length>limit||value.some(v=>typeof v!=='string'||!validate(v)))throw new TypeError('Invalid smart content filter')
  return [...new Set(value.map(v=>v.toLowerCase()))].sort()
}
function args({language,topic='solo',seed,offset=0,historyScope='neutral',storyIds=[],authorIds=[],storyTypes=[]}={}){
  if(!languages.has(language)||!topics.has(topic)||typeof seed!=='string'||!seed.trim()||seed.length>100||!Number.isInteger(offset)||offset<0||offset>900||offset%100!==0||!['neutral','telegram'].includes(historyScope))throw new TypeError('Invalid smart content request')
  const stories=list(storyIds,1000,v=>uuid.test(v)),authors=list(authorIds,1000,v=>uuid.test(v)),kinds=list(storyTypes,3,v=>types.has(v))
  if(historyScope==='telegram'&&(!['km','en'].includes(language)||stories.length||authors.length||kinds.length))throw new TypeError('Invalid Telegram compatibility request')
  return {p_language:language,p_topic:topic,p_seed:seed,p_offset:offset,p_history_scope:historyScope,p_story_ids:stories,p_author_ids:authors,p_story_types:kinds}
}
function validate(data,scope){
  if(!data||!Number.isInteger(data.scanned)||data.scanned<0||data.scanned>100||!Array.isArray(data.candidates)||data.candidates.length>100||!Array.isArray(data.history)||!Array.isArray(data.captions))throw new Error('SMART_CONTENT_INVALID_RESPONSE')
  if(scope==='neutral'&&(data.history.length||data.captions.length))throw new Error('SMART_CONTENT_HISTORY_ISOLATION')
  return data
}
export function createSmartContentSource(db,{cache=createCandidateCache()}={}){
  if(!db?.rpc||!cache?.get||!cache?.clear)throw new TypeError('Missing smart content dependencies')
  return {
    async candidatePage(options){
      const params=args(options)
      const load=async()=>{
        const {data,error}=await db.rpc('shadow_smart_content_candidate_page_v1',params)
        if(error)throw new Error('SMART_CONTENT_SOURCE_FAILED')
        return validate(data,params.p_history_scope)
      }
      return params.p_history_scope==='telegram'?load():cache.get(JSON.stringify(params),load)
    },
    async mangaPages(episodeId){
      if(typeof episodeId!=='string'||!uuid.test(episodeId))throw new TypeError('Invalid episode ID')
      const {data,error}=await db.rpc('telegram_promotion_v2_manga_pages',{p_episode_id:episodeId})
      if(error)throw new Error('SMART_CONTENT_MANGA_SOURCE_FAILED')
      if(!Array.isArray(data))throw new Error('SMART_CONTENT_INVALID_MANGA_RESPONSE')
      return data
    },
    clearCache(){cache.clear()}
  }
}
