const locales = Object.freeze({
  zh: {
    headings: ['GL 故事推荐','BL 故事推荐','浪漫故事','奇幻故事','喜剧故事','本周热门故事','值得发现的故事','已完结故事','已完结短篇','新故事推荐','相似题材推荐','睡前阅读推荐'],
    intros: ['今天来发现一些值得阅读的故事吧。','哪一部故事最吸引你？','把喜欢的故事加入阅读清单吧。','今天为你推荐 {count} 部故事。'],
    tagPrefix: '共同题材：', tags: ['GL','BL','爱情','喜剧','奇幻','恐怖','悬疑','剧情','动作','校园','历史','圆满结局']
  },
  ja: {
    headings: ['おすすめGL作品','おすすめBL作品','恋愛作品','ファンタジー作品','コメディ作品','今週の人気作品','まだ知らない名作','完結作品','完結済み短編','新着作品','似たジャンルの作品','寝る前のおすすめ作品'],
    intros: ['今日は新しい物語を見つけてみませんか。','どの作品が気になりますか？','気になる作品を読書リストに追加しましょう。','今日は {count} 作品をご紹介します。'],
    tagPrefix: '共通ジャンル：', tags: ['GL','BL','恋愛','コメディ','ファンタジー','ホラー','ミステリー','ドラマ','アクション','学園','歴史','ハッピーエンド']
  },
  ko: {
    headings: ['GL 작품 추천','BL 작품 추천','로맨스 작품','판타지 작품','코미디 작품','이번 주 인기 작품','숨은 추천 작품','완결 작품','완결 단편','신작 추천','비슷한 장르 추천','잠들기 전 추천 작품'],
    intros: ['오늘 새로운 이야기를 만나 보세요.','어떤 작품이 가장 궁금한가요?','마음에 드는 작품을 읽기 목록에 담아 보세요.','오늘은 {count}편의 작품을 추천합니다.'],
    tagPrefix: '공통 장르: ', tags: ['GL','BL','로맨스','코미디','판타지','공포','미스터리','드라마','액션','학원','역사','해피 엔딩']
  }
})
const topics = ['gl','bl','romance','fantasy','comedy','trending','hidden','completed','short','new','similar','night']
const tagKeys = ['gl','bl','romance','comedy','fantasy','horror','mystery','drama','action','school life','historical','happy ending']
const hash = value => { let h = 2166136261; for (const ch of String(value)) h = Math.imul(h ^ ch.codePointAt(0), 16777619); return h >>> 0 }

export function createSharedCaption({ chooseLegacyCaption, sharedStoryTags, normalizeLanguage }) {
  if (![chooseLegacyCaption, sharedStoryTags, normalizeLanguage].every(fn => typeof fn === 'function')) throw new TypeError('Missing shared caption dependencies')
  return function chooseCaption({ topic, language, stories, history = [], now = Date.now(), seed = '' }) {
    if (!topics.includes(topic) || !['km','en','zh','ja','ko'].includes(language) || !Array.isArray(stories) || stories.length < 1 || stories.length > 5 || !Array.isArray(history) || !Number.isFinite(now) || stories.some(s => !s?.id || normalizeLanguage(s.story_language) !== language)) throw new TypeError('Invalid shared caption request')
    const scopedHistory = history.filter(h => h && normalizeLanguage(h.language) === language).map(h => ({ ...h, language }))
    if (language === 'km' || language === 'en') return chooseLegacyCaption({ topic, language, stories, history: scopedHistory, now, seed })
    const locale = locales[language]
    const recent = new Set(scopedHistory.filter(h => ['ready','sending'].includes(h.status) || Date.parse(h.sentAt || h.updatedAt) >= now - 7 * 86400000).map(h => h.captionId))
    const available = locale.intros.map((text, index) => ({ text, id: `${language}:${topic}:${index}` })).filter(item => !recent.has(item.id))
    if (!available.length) return null
    const choice = available[hash(`${seed}:${topic}:${language}`) % available.length]
    const tags = sharedStoryTags(stories).filter(tag => tag !== topic && tagKeys.includes(tag)).slice(0,2).map(tag => locale.tags[tagKeys.indexOf(tag)])
    return { captionId: choice.id, heading: locale.headings[topics.indexOf(topic)], intro: choice.text.replaceAll('{count}', String(stories.length)), tagLine: tags.length ? locale.tagPrefix + tags.join(' · ') : '' }
  }
}
