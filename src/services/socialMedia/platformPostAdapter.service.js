const labels = Object.freeze({
  km: ['📖 អានរឿងនៅ Shadow','📖 ស្វែងរកចំណងជើងរឿងនៅ Shadow'],
  en: ['📖 Read on Shadow','📖 Search the story title on Shadow'],
  zh: ['📖 在 Shadow 阅读','📖 在 Shadow 搜索故事标题'],
  ja: ['📖 Shadow で読む','📖 Shadow で作品名を検索'],
  ko: ['📖 Shadow에서 읽기','📖 Shadow에서 작품 제목 검색']
})
const formats = new Set(['cover','short_preview','cover_group','manga_preview'])
const storyUrl = /^https:\/\/www\.shadowerabook\.site\/story\/[0-9a-f-]{36}$/i
export function adaptSocialPromotionPost({platform,content}={}) {
  if (!['facebook','instagram'].includes(platform)) throw new TypeError('SOCIAL_PLATFORM_NOT_AVAILABLE')
  if (!content || !Object.hasOwn(labels,content.language) || !formats.has(content.format) || typeof content.caption!=='string' || !content.caption.trim() || content.caption.length>1800 || !Array.isArray(content.photos) || !Array.isArray(content.stories)) throw new TypeError('SOCIAL_CONTENT_INVALID')
  const group=content.format==='cover_group', album=group||content.format==='manga_preview'
  if (group?content.stories.length<3||content.stories.length>5:content.stories.length!==1) throw new TypeError('SOCIAL_STORY_COUNT')
  if (album?content.photos.length<3||content.photos.length>5:content.photos.length!==1) throw new TypeError('SOCIAL_PHOTO_COUNT')
  if (group && content.photos.length!==content.stories.length) throw new TypeError('SOCIAL_GROUP_MEDIA_COUNT')
  if (content.stories.some(s=>!s?.id||typeof s.title!=='string'||!s.title.trim()||s.title.length>100||!storyUrl.test(s.url)||!s.url.endsWith('/'+s.id)) || new Set(content.stories.map(s=>s.id)).size!==content.stories.length) throw new TypeError('SOCIAL_STORY_LINK_INVALID')
  const photos=content.photos.map(value=>{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port)throw new TypeError('SOCIAL_PHOTO_INVALID');return u.href})
  if (new Set(photos).size!==photos.length) throw new TypeError('SOCIAL_PHOTO_DUPLICATE')
  const facebook=platform==='facebook'
  const list=group?content.stories.map((s,i)=>`${i+1}. ${s.title}${facebook?`\n${s.url}`:''}`).join('\n'):facebook?content.stories[0].url:''
  const caption=[content.caption,list,labels[content.language][facebook?0:1]].filter(Boolean).join('\n\n')
  if (caption.length>2200) throw new RangeError('SOCIAL_CAPTION_LIMIT')
  return {platform,language:content.language,format:content.format,mediaType:album?'carousel':'photo',caption,photos,storyIds:content.stories.map(s=>s.id),episodeIds:content.stories.map(s=>s.episodeId),captionId:content.captionId}
}
