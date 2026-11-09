export const SMART_AD_POLICY = Object.freeze({
  minNovelEpisodes: 5,
  shortCompletedMaxEpisodes: 9,
  ongoingMaxInactiveDays: 90,
  preferredUpdateDays: 30,
  shortExposureShare: 0.10,
  popularExposureShare: 0.05,
  initialCapacity: 1000,
  expansionStep: 250,
  maxCapacity: 3000,
  weeklyRefreshMs: 7 * 86400000,
  dailyRefreshMs: 86400000,
  rotationMs: 6 * 3600000,
})

const SHORT_TYPES = new Set(['short', 'short_story', 'short_novel'])

function timestamp(value) {
  const time = value ? Date.parse(value) : NaN
  return Number.isFinite(time) ? time : null
}

export function classifySmartAdStory(story, publishedEpisodeCount) {
  const type = String(story?.story_type || 'novel').trim().toLowerCase()
  const completed = String(story?.story_status || '').trim().toLowerCase() === 'completed'
  const count = Math.max(0, Number(publishedEpisodeCount) || 0)
  if (SHORT_TYPES.has(type)) return 'short'
  if (type !== 'novel') return 'unsupported'
  // Match the existing Task Center convention until Shadow has a dedicated
  // short/long field: completed novels with <= 9 episodes count as short.
  if (completed && count <= SMART_AD_POLICY.shortCompletedMaxEpisodes) return 'short'
  return 'novel'
}

export function evaluateSmartAdEligibility(story, episodeSummary, now = Date.now()) {
  const reject = (reason) => ({ eligible: false, reason, story_kind: null, freshness_days: null })
  if (!story?.id || !String(story.title || '').trim()) return reject('missing_story')
  if (String(story.status || '').toLowerCase() !== 'published' || story.deleted_at) return reject('not_published')
  if (!['', 'active'].includes(String(story.admin_visibility_status || '').toLowerCase())) return reject('admin_hidden')
  if (story.is_adult === true) return reject('adult_story')
  if (story.is_shadow_exclusive && String(story.exclusive_status || '').toLowerCase() !== 'approved') {
    return reject('exclusive_not_approved')
  }
  if (!episodeSummary?.first_episode_id) return reject('missing_first_published_episode')

  const count = Math.max(0, Number(episodeSummary.published_episode_count) || 0)
  const kind = classifySmartAdStory(story, count)
  if (kind === 'unsupported') return reject('unsupported_story_type')
  if (kind === 'novel' && count < SMART_AD_POLICY.minNovelEpisodes) return reject('too_few_published_episodes')
  const completed = String(story.story_status || '').trim().toLowerCase() === 'completed'
  if (kind === 'short' && !completed) return reject('short_not_completed')

  const publishedAt = timestamp(episodeSummary.last_episode_published_at)
  if (publishedAt === null || publishedAt > now) return reject('invalid_episode_publish_date')
  const ageDays = Math.max(0, (now - publishedAt) / 86400000)
  if (!completed && ageDays > SMART_AD_POLICY.ongoingMaxInactiveDays) return reject('ongoing_inactive')
  return {
    eligible: true,
    reason: null,
    story_kind: kind,
    freshness_days: ageDays,
    fresh_30_days: ageDays <= SMART_AD_POLICY.preferredUpdateDays,
  }
}

export function clampSmartAdCapacity(value) {
  const requested = Number.isFinite(Number(value)) ? Number(value) : SMART_AD_POLICY.initialCapacity
  const rounded = Math.ceil(Math.max(SMART_AD_POLICY.initialCapacity, requested) / SMART_AD_POLICY.expansionStep)
    * SMART_AD_POLICY.expansionStep
  return Math.min(SMART_AD_POLICY.maxCapacity, rounded)
}

export function smartAdCambodiaSlot(now = Date.now()) {
  const offset = 7 * 3600000
  const start = Math.floor((now + offset) / SMART_AD_POLICY.rotationMs) * SMART_AD_POLICY.rotationMs - offset
  const local = new Date(start + offset).toISOString()
  return {
    slot_key: `${local.slice(0, 10)}T${local.slice(11, 13)}:00`,
    starts_at: new Date(start).toISOString(),
    next_rotation_at: new Date(start + SMART_AD_POLICY.rotationMs).toISOString(),
  }
}
