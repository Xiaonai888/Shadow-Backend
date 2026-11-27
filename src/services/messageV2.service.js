import { normalizePromotionLanguage } from './policy.service.js'
import { extractPromotionText, truncatePromotionText } from './extractor.service.js'
import { resolvePreviewSafety, addExcerptSpoiler, buildMangaAlbum } from './safePreviewV2.service.js'

const BASE='https://www.shadowerabook.site'
const DEFAULT_LINKS={register:`${BASE}/register`,install:`${BASE}/install`,tutorial:'https://youtu.be/gMUvBCkkPHQ?si=ZZKdPMcLuX6KzE2i'}
const TYPES={novel:'Novel',manga:'Manga',chat_story:'Chat Story'}
const LABELS={km:['📖 អានរឿងបន្ត','👤 បង្កើតគណនី','📲 ដំឡើងកម្មវិធី','🎬 របៀបប្រើប្រាស់'],en:['📖 Continue reading','👤 Create account','📲 Install app','🎬 Tutorial']}
const SOLO={km:{completed:'✅ រឿងចេញចប់',short:'📕 រឿងខ្លីដែលចេញចប់',trending:'🔥 រឿងពេញនិយមប្រចាំសប្តាហ៍',hidden:'💎 ស្នាដៃដែលអ្នកប្រហែលជាមិនទាន់ស្គាល់',author:'✍️ ស្នាដៃអ្នកនិពន្ធ',new:'🆕 ស្វែងរករឿងថ្មី',default:'📖 រឿងណែនាំសម្រាប់ថ្ងៃនេះ'},en:{completed:'✅ Completed Story',short:'📕 Short & Completed',trending:'🔥 Weekly Trending',hidden:'💎 Hidden Gem',author:'✍️ Featured Author',new:'🆕 Discover New Stories',default:'📖 Today’s Reading Pick'}}
const clean=(v,n)=>truncatePromotionText(String(v??'').replace(/[\r\n\t]+/g,' ').trim(),n)
function url(v){if(!String(v??'').trim())throw new TypeError('Missing promotion URL');const u=new URL(String(v),BASE);if(u.protocol!=='https:'||u.username||u.password)throw new TypeError('Invalid promotion URL');return u.href}
function absolutePhoto(v){const u=new URL(String(v??''));if(u.protocol!=='https:'||u.username||u.password)throw new TypeError('Invalid preview photo');return u.href}
export function updateStatusV2({story,episode,statusContext=null}={}){
  if(statusContext?.storyId!==story?.id||statusContext?.episodeId!==episode?.id)return 'update'
  if(statusContext.justCompleted===true&&String(story.story_status||'').toLowerCase()==='completed')return 'completed'
  if(statusContext.firstEpisode===true)return 'new'
  return 'update'
}
export function buildStoryPromotionV2({story,episode,language,postType='update',topic='default',statusContext=null,authorName='',links={},mangaPreview=null,approvedPublicPreview=false,approvedPublicCover=false,safeCoverUrl=null,content=episode?.content}={}){
  const lang=normalizePromotionLanguage(language)
  if(!LABELS[lang]||!['update','solo'].includes(postType)||!story?.id||!episode?.id||String(episode.story_id)!==String(story.id)||normalizePromotionLanguage(story.story_language)!==lang)throw new TypeError('Invalid V2 promotion story')
  const title=clean(story.title,160);if(!title)throw new TypeError('Missing story title')
  const type=TYPES[String(story.story_type||'novel').toLowerCase()]||'Novel'
  const safety=resolvePreviewSafety({story,episode,approvedPublicPreview,approvedPublicCover})
  const manga=type==='Manga'
  const status=updateStatusV2({story,episode,statusContext})
  const heading=postType==='update'?`${status==='new'?'🆕 New Story':status==='completed'?'✅ Just Completed':'🔔 Update Today'} · ${type}`:`${SOLO[lang][topic]||SOLO[lang].default} · ${type}`
  const isAlbum=manga&&safety.allowExcerpt&&Array.isArray(mangaPreview?.photos)&&mangaPreview.photos.length>=3&&mangaPreview.photos.length<=5&&Number.isFinite(mangaPreview.coveragePercent)&&mangaPreview.coveragePercent>0&&mangaPreview.coveragePercent<=30
  const cover=safety.allowCover?story.cover_url:safeCoverUrl
  if(!isAlbum&&!cover)return null
  const author=clean(authorName,80),ep=clean(episode.title,160)
  const header=[heading,[title,ep].filter(Boolean).join('\n'),author?`✍️ ${author}`:'',safety.restricted?(lang==='km'?'🔞 មាតិកាសម្រាប់មនុស្សពេញវ័យ':'🔞 Mature content'):''].filter(Boolean).join('\n\n')
  const labels=LABELS[lang]
  const urls=[`${BASE}/story/${encodeURIComponent(story.id)}`, ...['register','install','tutorial'].map(k=>links[k]||DEFAULT_LINKS[k])].map(url)
  const inlineLinks=postType==='update'||isAlbum
  const footer=inlineLinks?`${labels[0]}  ${labels[1]}\n${labels[2]}  ${labels[3]}`:''
  const limit=postType==='update'?960:1000
  const budget=limit-header.length-footer.length-4
  const excerpt=!manga&&safety.allowExcerpt?extractPromotionText(content,{budget}):''
  const prefix=header+(excerpt?`\n\n${excerpt}`:'')
  const caption=prefix+(footer?`\n\n${footer}`:'')
  if(caption.length>limit)throw new RangeError('V2 caption exceeds limit')
  let entities=[{type:'bold',offset:heading.length+2,length:title.length}]
  if(excerpt&&safety.spoiler)entities=addExcerptSpoiler({caption,entities,excerptOffset:header.length+2,excerptLength:excerpt.length,enabled:true})
  if(inlineLinks){let offset=prefix.length+2;for(let i=0;i<labels.length;i++){entities.push({type:'text_link',offset,length:labels[i].length,url:urls[i]});offset+=labels[i].length+(i===0||i===2?2:i===1?1:0)}}
  if(isAlbum){const photos=mangaPreview.photos.map(absolutePhoto);return {media:buildMangaAlbum({photos,caption,captionEntities:entities,spoiler:safety.spoiler})}}
  const button=i=>({text:labels[i],url:urls[i]})
  return {photo:safety.allowCover?url(cover):absolutePhoto(cover),caption,caption_entities:entities,reply_markup:{inline_keyboard:inlineLinks?[]:[[button(0)],[button(1),button(2)],[button(3)]]}}
}
export function createPromotionMessageBuilderV2({source,statusSource=null,safeCoverUrl=null}={}){
  if(!source?.mangaPreview)throw new TypeError('Missing Manga source')
  return {async build(options){
    const {story,episode,postType='update',approvedPublicPreview=false}=options
    const statusContext=postType==='update'&&statusSource?await statusSource.status(story.id,episode.id):null
    const safety=resolvePreviewSafety({story,episode,approvedPublicPreview})
    const mangaPreview=String(story.story_type).toLowerCase()==='manga'&&safety.allowExcerpt?await source.mangaPreview(episode.id):null
    return buildStoryPromotionV2({...options,statusContext,mangaPreview,safeCoverUrl})
  }}
}
