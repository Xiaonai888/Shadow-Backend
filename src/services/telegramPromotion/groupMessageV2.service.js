import { chooseGroupCaption, storyTags } from './captionLibraryV2.service.js'
import { isRecommendationEligible, matchesRecommendationTopic } from './recommendationV2.service.js'
const BASE='https://www.shadowerabook.site'
const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'})
function truncate(value,max){let text='';for(const {segment} of segmenter.segment(String(value??'').replace(/[\r\n\t]+/g,' ').trim())){if(text.length+segment.length>max)break;text+=segment}return text}
function photoUrl(value){const url=new URL(String(value),BASE);if(url.protocol!=='https:'||url.username||url.password)throw new TypeError('Invalid cover URL');return url.href}
export function buildGroupPromotionMessage({candidates,topic,language,history=[],now=Date.now(),seed='',similarTags=[]}){
  if(!Array.isArray(candidates)||candidates.length<3||candidates.length>5||(topic==='night'&&candidates.length!==3))throw new TypeError('Invalid group size')
  if(!candidates.every(c=>isRecommendationEligible(c,{language,now})))throw new TypeError('Ineligible group story')
  if(!candidates.every(c=>matchesRecommendationTopic(c,topic,now,similarTags)))throw new TypeError('Group topic mismatch')
  const stories=candidates.map(c=>c.story);if(topic==='similar'&&!similarTags.some(tag=>stories.every(s=>storyTags(s).includes(tag))))throw new TypeError('Missing common tag');if(new Set(stories.map(s=>String(s.id))).size!==stories.length)throw new TypeError('Duplicate group story')
  const copy=chooseGroupCaption({topic,language,stories,history,now,seed});if(!copy)return null
  let caption=[copy.heading,copy.intro,copy.tagLine].filter(Boolean).join('\n\n')
  const entities=[{type:'bold',offset:0,length:copy.heading.length}]
  for(const [i,s] of stories.entries()){
    const title=truncate(s.title,100);if(!title)throw new TypeError('Missing story title')
    const prefix=`\n${String(i+1).padStart(2,'0')}. `;caption+=prefix
    entities.push({type:'text_link',offset:caption.length,length:title.length,url:`${BASE}/story/${encodeURIComponent(s.id)}`});caption+=title
  }
  if(caption.length>1000)throw new RangeError('Group caption exceeds safe limit')
  const media=stories.map((s,i)=>({type:'photo',media:photoUrl(s.cover_url),...(i===0?{caption,caption_entities:entities}:{})}))
  return {media,storyIds:stories.map(s=>String(s.id)),captionId:copy.captionId,topic}
}
