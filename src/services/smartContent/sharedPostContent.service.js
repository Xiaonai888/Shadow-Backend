const locales = Object.freeze({
  km: { update: '🔔 ភាគថ្មីថ្ងៃនេះ', new: '🆕 រឿងថ្មី', completed: '✅ រឿងទើបចេញចប់', solo: '📖 រឿងណែនាំ', author: 'អ្នកនិពន្ធ', novel: 'ប្រលោមលោក', manga: 'រឿងតុក្កតា', chat_story: 'រឿងជជែក' },
  en: { update: '🔔 Update Today', new: '🆕 New Story', completed: '✅ Just Completed', solo: '📖 Reading Pick', author: 'Author', novel: 'Novel', manga: 'Manga', chat_story: 'Chat Story' },
  zh: { update: '🔔 今日更新', new: '🆕 新故事', completed: '✅ 刚刚完结', solo: '📖 阅读推荐', author: '作者', novel: '小说', manga: '漫画', chat_story: '聊天故事' },
  ja: { update: '🔔 本日の更新', new: '🆕 新着作品', completed: '✅ 完結しました', solo: '📖 おすすめ作品', author: '作者', novel: '小説', manga: '漫画', chat_story: 'チャット小説' },
  ko: { update: '🔔 오늘의 업데이트', new: '🆕 신작', completed: '✅ 최근 완결', solo: '📖 추천 작품', author: '작가', novel: '소설', manga: '만화', chat_story: '채팅 소설' }
})
const types = new Set(['novel','manga','chat_story'])
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const base = 'https://www.shadowerabook.site'
const finiteTime = v => Number.isFinite(Date.parse(v))
function photo(value) {
  try {
    const u = new URL(value, base)
    if (!value || u.protocol !== 'https:' || u.username || u.password || u.port) return null
    return u.href
  } catch { return null }
}
function isFreePreview(episode) {
  return episode?.is_free_published === true && episode?.is_locked === false
}
export function createSharedPostContent({ normalizeLanguage, evaluatePromotion, isEligible, matchesTopic, extractText, truncateText, chooseCaption, updateStatus, selectMangaPreview }) {
  if (![normalizeLanguage,evaluatePromotion,isEligible,matchesTopic,extractText,truncateText,chooseCaption,updateStatus,selectMangaPreview].every(fn => typeof fn === 'function')) throw new TypeError('SMART_CONTENT_POST_DEPENDENCIES')
  function line(value, max) {
    return truncateText(String(value ?? '').replace(/[\r\n\t\u0000-\u001f]+/g,' ').trim(), max)
  }
  function validate(c, language, now, kind, topic, similarTags) {
    const s = c?.story, e = c?.episode
    if (!uuid.test(s?.id || '') || !uuid.test(e?.id || '') || String(e.story_id) !== String(s.id) || !s.author_id || normalizeLanguage(s.story_language) !== language || !s.title || !photo(s.cover_url)) return false
    if (s.is_adult !== false || e.is_adult !== false || !['','visible'].includes(String(s.ranking_visibility_status || '').toLowerCase())) return false
    if (e.scheduled_at && (!finiteTime(e.scheduled_at) || Date.parse(e.scheduled_at) > now)) return false
    if (!evaluatePromotion({ story:s,episode:e,kind:'update',language,now }).eligible) return false
    if (kind === 'update') return true
    const legacyLanguage = language === 'km' ? 'km' : 'en'
    const adapted = { ...c, story: { ...s, story_language: legacyLanguage } }
    return isEligible(adapted,{language:legacyLanguage,now}) && (topic === 'solo' || matchesTopic(adapted,topic,now,similarTags))
  }
  function build({ language, kind, topic='solo', candidates, now=Date.now(), seed='', captionHistory=[], similarTags=[], statusContext=null, mangaPages=null }={}) {
    if (!Object.hasOwn(locales,language) || !['update','solo','group'].includes(kind) || !Number.isFinite(now) || !Array.isArray(candidates) || !Array.isArray(captionHistory) || !Array.isArray(similarTags)) throw new TypeError('SMART_CONTENT_POST_INVALID')
    if (kind === 'group' ? candidates.length < 3 || candidates.length > 5 || topic === 'solo' || (topic === 'night' && candidates.length !== 3) : candidates.length !== 1) throw new TypeError('SMART_CONTENT_POST_COUNT')
    if (new Set(candidates.map(c=>c?.story?.id)).size !== candidates.length || !candidates.every(c=>validate(c,language,now,kind,topic,similarTags))) return null
    const locale = locales[language]
    const stories = candidates.map(c=>({id:c.story.id,episodeId:c.episode.id,title:line(c.story.title,100),url:`${base}/story/${encodeURIComponent(c.story.id)}`}))
    if (stories.some(s=>!s.title)) return null
    const covers = candidates.map(c=>photo(c.story.cover_url))
    if (new Set(covers).size !== covers.length) return null
    if (kind === 'group') {
      const copy = chooseCaption({topic,language,stories:candidates.map(c=>c.story),history:captionHistory,now,seed})
      if (!copy) return null
      const caption = [copy.heading,copy.intro,copy.tagLine].filter(Boolean).join('\n\n')
      return { language,kind,format:'cover_group',caption,captionId:copy.captionId,stories,photos:covers }
    }
    const c = candidates[0], s=c.story, e=c.episode
    const type=String(s.story_type || 'novel').toLowerCase()
    if (!types.has(type)) return null
    const status=kind==='update'?updateStatus({story:s,episode:e,statusContext}):'solo'
    const heading=locale[status] || locale.solo
    const author=line(c.authorName,80)
    const caption=[`${heading} · ${locale[type]}`,stories[0].title,line(e.title,160),author?`✍️ ${locale.author}: ${author}`:''].filter(Boolean).join('\n\n')
    let excerpt='', photos=covers, format='cover'
    if (isFreePreview(e)) {
      if (type==='manga' && Array.isArray(mangaPages)) {
        const preview=selectMangaPreview(mangaPages)
        const media=Array.isArray(preview?.photos)?preview.photos.map(photo):[]
        if (media.length>=3 && media.length<=5 && media.every(Boolean) && new Set(media).size===media.length && Number.isFinite(preview.coveragePercent) && preview.coveragePercent>0 && preview.coveragePercent<=30) { photos=media; format='manga_preview' }
      } else if (type!=='manga' && typeof e.content==='string' && e.content.length<=1000000) {
        excerpt=extractText(e.content,{budget:Math.max(0,960-caption.length-4),percent:30,maxLines:15})
        if (excerpt) format='short_preview'
      }
    }
    return {language,kind,format,caption:caption+(excerpt?`\n\n${excerpt}`:''),captionId:null,stories,photos}
  }
  return { build }
}
