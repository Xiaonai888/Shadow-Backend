const labels={km:'📖 អានរឿងនៅ Shadow',en:'📖 Read on Shadow',zh:'📖 在 Shadow 阅读',ja:'📖 Shadow で読む',ko:'📖 Shadow에서 읽기'}
const formats=new Set(['cover','short_preview','cover_group','manga_preview'])
const chars=s=>[...s].length
const truncate=(s,n)=>chars(s)<=n?s:[...s].slice(0,Math.max(0,n-1)).join('').trimEnd()+'…'
export function adaptThreadsPromotionPost({content}={}){
  if(!content||!Object.hasOwn(labels,content.language)||!formats.has(content.format)||typeof content.caption!=='string'||!content.caption.trim()||content.caption.length>1800||!Array.isArray(content.photos)||!Array.isArray(content.stories))throw new TypeError('SOCIAL_THREADS_CONTENT_INVALID')
  const group=content.format==='cover_group',album=group||content.format==='manga_preview'
  if(group?content.stories.length<3||content.stories.length>5:content.stories.length!==1)throw new TypeError('SOCIAL_THREADS_STORY_COUNT')
  if(album?content.photos.length<3||content.photos.length>5:content.photos.length!==1)throw new TypeError('SOCIAL_THREADS_PHOTO_COUNT')
  if(group&&content.photos.length!==content.stories.length)throw new TypeError('SOCIAL_THREADS_MEDIA_COUNT')
  if(content.stories.some(s=>typeof s?.id!=='string'||!s.id||typeof s.episodeId!=='string'||!s.episodeId||typeof s.title!=='string'||!s.title.trim()||s.title.length>100||typeof s.url!=='string'||!/^https:\/\/www\.shadowerabook\.site\/story\/[0-9a-f-]{36}$/i.test(s.url)||!s.url.endsWith('/'+s.id))||new Set(content.stories.map(s=>s.id)).size!==content.stories.length)throw new TypeError('SOCIAL_THREADS_STORY_LINK_INVALID')
  const photos=content.photos.map(value=>{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash)throw new TypeError('SOCIAL_THREADS_PHOTO_INVALID');return u.href})
  if(new Set(photos).size!==photos.length)throw new TypeError('SOCIAL_THREADS_PHOTO_DUPLICATE')
  const links=content.stories.map((s,i)=>group?`${i+1}. ${truncate(s.title,16)}\n${s.url}`:s.url).join('\n')
  const suffix=`\n\n${labels[content.language]}\n${links}`
  const budget=500-chars(suffix)
  if(budget<1)throw new RangeError('SOCIAL_THREADS_CAPTION_LIMIT')
  const caption=truncate(content.caption.trim(),budget)+suffix
  return {platform:'threads',language:content.language,format:content.format,mediaType:album?'carousel':'photo',caption,photos,storyIds:content.stories.map(s=>s.id),episodeIds:content.stories.map(s=>s.episodeId),captionId:content.captionId}
}
