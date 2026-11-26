import { normalizePromotionLanguage, PROMOTION_POLICY } from './policy.service.js'
import { extractPromotionText, truncatePromotionText } from './extractor.service.js'
const COPY = Object.freeze({
  km: ['🆕 ភាគថ្មីចេញហើយ!', '✅ រឿងចេញចប់', '📕 រឿងខ្លី', '🔥 រឿងពេញនិយមប្រចាំសប្តាហ៍', '✍️ ស្នាដៃអ្នកនិពន្ធ', 'រឿង', 'ភាគ', 'អ្នកនិពន្ធ', 'ចុចទីនេះដើម្បីមើលរឿង', 'បង្កើតគណនី', 'ដំឡើង App', 'វីដេអូបង្កើត Account'],
  en: ['🆕 New episode!', '✅ Completed story', '📕 Short story', '🔥 Weekly trending', '✍️ Featured author', 'Story', 'Episode', 'Author', 'View story', 'Create account', 'Install app', 'Account tutorial'],
  zh: ['🆕 新章节发布！', '✅ 完结作品', '📕 短篇故事', '🔥 本周热门', '✍️ 作者推荐', '作品', '章节', '作者', '查看作品', '注册账号', '安装应用', '注册教程'],
  ko: ['🆕 새 회차 공개!', '✅ 완결 작품', '📕 단편 소설', '🔥 주간 인기', '✍️ 추천 작가', '작품', '회차', '작가', '작품 보기', '계정 만들기', '앱 설치', '가입 안내 영상'],
  ja: ['🆕 最新話公開！', '✅ 完結作品', '📕 短編小説', '🔥 今週の人気作品', '✍️ 注目の作家', '作品', '話', '作者', '作品を見る', 'アカウント作成', 'アプリをインストール', '登録ガイド動画'],
})
const BASE = 'https://www.shadowerabook.site'
const DEFAULT_LINKS = Object.freeze({ register: `${BASE}/register`, install: `${BASE}/install`, tutorial: 'https://youtu.be/gMUvBCkkPHQ?si=ZZKdPMcLuX6KzE2i' })
const clean = (value, limit) => truncatePromotionText(String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim(), limit)
function httpsUrl(value, base) {
  const url = new URL(String(value || ''), base)
  if (url.protocol !== 'https:' || url.username || url.password) throw new TypeError('Invalid HTTPS URL')
  return url.href
}
export function buildPromotionMessage({ story, episode, kind = 'update', language, authorName, links = {}, content = episode?.content }) {
  const lang = normalizePromotionLanguage(language)
  const copy = COPY[lang]
  const index = ['update', 'completed', 'short', 'trending', 'author'].indexOf(kind)
  if (!copy || index < 0 || !story?.id || !episode?.id || String(episode.story_id) !== String(story.id)) throw new TypeError('Invalid promotion message')
  if (!String(story.cover_url || '').trim() || !clean(story.title, 180)) throw new TypeError('Missing story title or cover')
  if (normalizePromotionLanguage(story.story_language) !== lang) throw new TypeError('Story language mismatch')
  const header = [copy[index], `📖 ${copy[5]}: ${clean(story.title, 180)}`, `📚 ${copy[6]} ${clean(episode.episode_number, 12)}${episode.title ? ` — ${clean(episode.title, 120)}` : ''}`, authorName ? `✍️ ${copy[7]}: ${clean(authorName, 80)}` : ''].filter(Boolean).join('\n')
  const excerpt = extractPromotionText(content, { budget: PROMOTION_POLICY.maxCaption - header.length - 2 })
  const caption = excerpt ? `${header}\n\n${excerpt}` : header
  const link = { ...DEFAULT_LINKS, ...links }
  const button = (text, url) => ({ text, url: httpsUrl(url) })
  return {
    photo: httpsUrl(story.cover_url, BASE), caption,
    reply_markup: { inline_keyboard: [
      [button(`📖 ${copy[8]}`, `${BASE}/story/${encodeURIComponent(story.id)}`)],
      [button(`👤 ${copy[9]}`, link.register), button(`📲 ${copy[10]}`, link.install)],
      [button(`▶️ ${copy[11]}`, link.tutorial)],
    ] },
  }
}
