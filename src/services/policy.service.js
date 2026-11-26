export const PROMOTION_LANGUAGES = Object.freeze({ km: 'Khmer', en: 'English', zh: 'Chinese', ko: 'Korean', ja: 'Japanese' })
export const PROMOTION_POLICY = Object.freeze({ gapSeconds: 300, activeDays: 30, storyCooldownDays: 14, authorCooldownDays: 30, excerptPercent: 30, maxLines: 15, maxCaption: 1000, timezone: 'Asia/Phnom_Penh' })
export const PROMOTION_SCHEDULE = Object.freeze([
  Object.freeze({ day: 1, time: '12:00', kind: 'completed' }),
  Object.freeze({ day: 1, time: '19:00', kind: 'completed' }),
  Object.freeze({ day: 2, time: '12:00', kind: 'short' }),
  Object.freeze({ day: 2, time: '19:00', kind: 'short' }),
  Object.freeze({ day: 3, time: '12:00', kind: 'author' }),
  Object.freeze({ day: 4, time: '12:00', kind: 'completed' }),
  Object.freeze({ day: 4, time: '19:00', kind: 'completed' }),
  Object.freeze({ day: 5, time: '12:00', kind: 'short' }),
  Object.freeze({ day: 5, time: '19:00', kind: 'short' }),
  Object.freeze({ day: 6, time: '12:00', kind: 'author' }),
  Object.freeze({ day: 0, time: '12:00', kind: 'trending' }),
  Object.freeze({ day: 0, time: '19:00', kind: 'trending' }),
])
export function normalizePromotionLanguage(value) {
  const key = String(value ?? '').trim().toLowerCase().replace(/_/g, '-').split('-')[0]
  if (key === 'kh') return 'km'
  if (key === 'kr') return 'ko'
  if (key === 'jp') return 'ja'
  return Object.keys(PROMOTION_LANGUAGES).find(code => code === key || PROMOTION_LANGUAGES[code].toLowerCase() === key) || null
}
export function cambodiaDay(now = Date.now()) {
  return new Date(now + 7 * 3600000).toISOString().slice(0, 10)
}
export function isCompleted(story) {
  return String(story?.story_status || '').trim().toLowerCase() === 'completed'
}
function recent(value, now, days) {
  const date = value ? Date.parse(value) : NaN
  return Number.isFinite(date) && date <= now && date >= now - days * 86400000
}
export function evaluatePromotion({ story, episode, kind, language, authorLastActiveAt, lastEpisodePublishedAt, publishedEpisodeCount, now = Date.now() }) {
  const reject = reason => ({ eligible: false, reason })
  if (!['update', 'completed', 'short', 'trending', 'author'].includes(kind)) return reject('invalid_kind')
  if (!story?.id || !episode?.id || String(episode.story_id) !== String(story.id)) return reject('missing_story_or_episode')
  if (!normalizePromotionLanguage(language) || normalizePromotionLanguage(story.story_language) !== normalizePromotionLanguage(language)) return reject('language_mismatch')
  if (story.status !== 'published' || episode.status !== 'published' || story.deleted_at || episode.deleted_at) return reject('not_published')
  if (!['', 'active'].includes(String(story.admin_visibility_status || '').toLowerCase())) return reject('admin_hidden')
  if (story.is_adult || episode.is_adult) return reject('adult_content')
  if (story.is_shadow_exclusive && story.exclusive_status !== 'approved') return reject('exclusive_not_approved')
  const first = Date.parse(episode.first_published_at || '')
  const published = Date.parse(episode.published_at || episode.first_published_at || '')
  if (!Number.isFinite(first) || !Number.isFinite(published) || first > now || published > now || (episode.scheduled_at && Date.parse(episode.scheduled_at) > now)) return reject('not_yet_published')
  if (kind === 'update') return { eligible: true, reason: null }
  const completed = isCompleted(story)
  if (kind === 'completed' && !completed) return reject('not_completed')
  if (kind === 'short') {
    const type = String(story.story_type || 'novel').toLowerCase()
    const count = Number(publishedEpisodeCount)
    if (!completed || !(['short', 'short_story', 'short_novel'].includes(type) || (type === 'novel' && Number.isInteger(count) && count >= 1 && count <= 9))) return reject('not_short')
  }
  if ((!completed || kind === 'author') && !recent(authorLastActiveAt, now, PROMOTION_POLICY.activeDays)) return reject('author_inactive')
  if (!completed && !recent(lastEpisodePublishedAt, now, PROMOTION_POLICY.activeDays)) return reject('story_inactive')
  return { eligible: true, reason: null }
}
