import { GROUP_TOPICS, storyTags } from './captionLibraryV2.service.js'
const DAY=86400000
const localDay=ms=>new Date(ms+7*3600000).toISOString().slice(0,10)
const languages={km:'km',kh:'km',khmer:'km',en:'en',english:'en'}
const lang=v=>languages[String(v??'').trim().toLowerCase()]||null
const completed=s=>String(s?.story_status??'').trim().toLowerCase()==='completed'
const recent=(value,now,days)=>{const ms=Date.parse(value);return Number.isFinite(ms)&&ms<=now&&ms>=now-days*DAY}
const number=v=>v===null||v===undefined||v===''?NaN:Number(v)
const hash=value=>{let h=2166136261;for(const ch of String(value))h=Math.imul(h^ch.codePointAt(0),16777619);return h>>>0}
export function isShortCompleted(candidate){const s=candidate.story;const type=String(s.story_type||'novel').toLowerCase();const n=number(candidate.publishedEpisodeCount);return completed(s)&&(['short','short_story','short_novel'].includes(type)||(type==='novel'&&n>=5&&n<=9))}
export function isRecommendationEligible(candidate,{language,now=Date.now()}={}){
  const s=candidate?.story;const ep=candidate?.episode;const count=number(candidate?.publishedEpisodeCount)
  if(!s?.id||!s.title||!s.author_id||!s.cover_url||!lang(language)||lang(s.story_language)!==lang(language))return false
  if(s.status!=='published'||s.deleted_at||s.is_adult||!['','active'].includes(String(s.admin_visibility_status||'').toLowerCase())||!['','visible'].includes(String(s.ranking_visibility_status||'').toLowerCase())||(s.is_shadow_exclusive&&s.exclusive_status!=='approved'))return false
  if(!ep?.id||String(ep.story_id)!==String(s.id)||ep.status!=='published'||ep.deleted_at||ep.is_adult)return false
  const first=Date.parse(ep.first_published_at||ep.published_at);const pub=Date.parse(ep.published_at||ep.first_published_at)
  if(!Number.isFinite(first)||!Number.isFinite(pub)||first>now||pub>now||(ep.scheduled_at&&!(Date.parse(ep.scheduled_at)<=now)))return false
  if(!Number.isInteger(count)||count<5)return false
  return completed(s)||(recent(candidate.authorLastActiveAt,now,30)&&recent(candidate.lastEpisodePublishedAt,now,30))
}
export function matchesRecommendationTopic(c,topic,now,similarTags=[]){const s=c.story;const tags=storyTags(s);switch(topic){case 'gl':case 'bl':case 'romance':case 'fantasy':case 'comedy':return tags.includes(topic);case 'completed':return completed(s);case 'short':return isShortCompleted(c);case 'new':return recent(c.episode.first_published_at||c.episode.published_at,now,14);case 'trending':return number(c.activity7)>0;case 'hidden':return Number.isFinite(number(s.total_views))&&number(s.total_views)>=0;case 'similar':return similarTags.length>0&&similarTags.some(t=>tags.includes(t));case 'night':return true;default:return false}}
function exposure(history,language,now){const map=new Map();for(const h of history){if(lang(h.language)!==lang(language)||!h.storyId)continue;const date=Date.parse(h.sentAt||h.updatedAt);const time=['ready','sending'].includes(h.status)?Infinity:['sent','uncertain'].includes(h.status)&&Number.isFinite(date)?date:-Infinity;if(time>(map.get(String(h.storyId))??-Infinity))map.set(String(h.storyId),time)}return map}
export function selectRecommendationGroup({candidates,language,topic,history=[],now=Date.now(),count=topic==='night'?3:5,seed=localDay(now),similarTags=[]}){
  if(!GROUP_TOPICS.includes(topic)||!lang(language)||!Number.isInteger(count)||count<3||count>5||!Array.isArray(candidates))throw new TypeError('Invalid recommendation selection')
  if(topic==='night')count=3
  const seen=new Set();const eligible=candidates.filter(c=>{if(!isRecommendationEligible(c,{language,now})||!matchesRecommendationTopic(c,topic,now,similarTags)||seen.has(String(c.story.id)))return false;seen.add(String(c.story.id));return true})
  const last=exposure(history,language,now)
  const compare=(a,b)=>{if(topic==='trending')return number(b.activity7)-number(a.activity7)||hash(seed+a.story.id)-hash(seed+b.story.id);if(topic==='hidden')return number(a.story.total_views)-number(b.story.total_views)||hash(seed+a.story.id)-hash(seed+b.story.id);const av=last.get(String(a.story.id))??-Infinity,bv=last.get(String(b.story.id))??-Infinity;return (av===bv?0:av<bv?-1:1)||hash(seed+a.story.id)-hash(seed+b.story.id)}
  let sorted=eligible.sort(compare)
  if(topic==='similar'){const shared=similarTags.map(tag=>({tag,rows:sorted.filter(c=>storyTags(c.story).includes(tag))})).sort((a,b)=>b.rows.length-a.rows.length)[0];sorted=shared?.rows||[]}
  const tiers=topic==='night'?[14,7,3,1]:[14]
  let pool=[];let cooldownDays=14
  for(const days of tiers){cooldownDays=days;pool=sorted.filter(c=>{const t=last.get(String(c.story.id))??-Infinity;return t===-Infinity||(Number.isFinite(t)&&t<=now-days*DAY&&localDay(t)!==localDay(now)&&localDay(t)!==localDay(now-DAY))});if(pool.length>=count)break}
  if(pool.length<3)return {stories:[],cooldownDays,reason:'insufficient_eligible_stories'}
  const selected=[];const authors=new Set()
  const add=c=>{if(!c||selected.includes(c)||selected.length>=count)return;selected.push(c);authors.add(c.story.author_id)}
  const pick=list=>list.find(c=>!selected.includes(c)&&!authors.has(c.story.author_id))||list.find(c=>!selected.includes(c))
  if(topic==='night'){
    const popular=pool.filter(c=>number(c.activity7)>0).sort((a,b)=>number(b.activity7)-number(a.activity7))
    const lesserKnown=pool.filter(c=>Number.isFinite(number(c.story.total_views))&&number(c.story.total_views)>=0).sort((a,b)=>number(a.story.total_views)-number(b.story.total_views))
    const short=pool.filter(isShortCompleted);const finished=pool.filter(c=>completed(c.story))
    const choices=[popular,lesserKnown,short.length?short:finished];const shift=hash(seed)%3
    for(let i=0;i<3;i++)add(pick(choices[(i+shift)%3]))
  }
  if(topic==='trending'){for(const c of pool)add(c)}else{while(selected.length<count){const c=pick(pool);if(!c)break;add(c)}}
  return {stories:selected,cooldownDays,reason:null}
}
