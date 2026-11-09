import { SMART_AD_POLICY, smartAdCambodiaSlot } from './smartAdEligibility.service.js'

export const SMART_AD_PLACEMENTS = Object.freeze(['discover', 'opening', 'freeUnlock', 'me'])

function hash(text) {
  let value = 2166136261
  for (const character of String(text)) {
    value ^= character.charCodeAt(0)
    value = Math.imul(value, 16777619)
  }
  return value >>> 0
}

function normalize(value) { return String(value || '').trim().toLowerCase() }
function count(value) { return Math.max(0, Number(value) || 0) }

function interestScore(record, interests) {
  const genre = normalize(record.genre || record.main_genre)
  const tags = Array.isArray(record.tags) ? record.tags : []
  return count(interests[genre]) * 15 + tags.reduce((sum, tag) => sum + count(interests[normalize(tag)]) * 4, 0)
}

function relevantExposure(stats, storyId) {
  const item = stats?.[String(storyId)] || {}
  return { impressions: count(item.impressions), clicks: count(item.clicks) }
}

export function scoreSmartAd(record, { interests = {}, exposure = {}, seed = '', now = Date.now() } = {}) {
  const views = count(record.total_views)
  const { impressions, clicks } = relevantExposure(exposure, record.story_id)
  const ctr = (clicks + 1) / (impressions + 8)
  const last = Date.parse(record.last_episode_published_at || '')
  const freshnessDays = Number.isFinite(last) ? Math.max(0, (now - last) / 86400000) : 9999
  const freshBoost = freshnessDays <= 30 ? 12 : freshnessDays <= 90 ? 4 : 0
  const lowViewBoost = 50 / (1 + Math.log1p(views))
  const impressionPenalty = Math.log1p(impressions) * (clicks === 0 ? 6 : 2)
  return interestScore(record, interests) + lowViewBoost + freshBoost + ctr * 16
    - impressionPenalty + (hash(`${seed}:${record.story_id}`) % 1000) / 1000
}

export function chooseSmartAdSelection({
  candidates = [], readerKey = 'anonymous', placement = 'discover', slotKey = smartAdCambodiaSlot().slot_key,
  interests = {}, exposure = {}, seenInSlot = [], cooldownIds = [], queueIndex = 0,
  allowFreeUnlockLoop = false, now = Date.now(),
} = {}) {
  if (!SMART_AD_PLACEMENTS.includes(placement)) throw new RangeError('Unknown Smart Ad placement')
  const limit = placement === 'opening' || placement === 'me' ? 1 : 10
  const blocked = new Set(seenInSlot.map(String))
  const cooling = new Set(cooldownIds.map(String))
  const unique = new Map()
  for (const story of candidates) {
    if (!story?.story_id || !story.first_episode_id) continue
    const id = String(story.story_id)
    if (!unique.has(id)) unique.set(id, story)
  }
  const pool = [...unique.values()]
  const available = pool.filter((story) => !blocked.has(String(story.story_id)) && !cooling.has(String(story.story_id)))
  // Repetition is permitted only for Free Unlock after its ten-item queue is exhausted.
  const from = available.length ? available :
    (allowFreeUnlockLoop && placement === 'freeUnlock' ? pool : [])
  if (!from.length) return []
  const seed = `${readerKey}:${placement}:${slotKey}:${queueIndex}`
  const popularCutoff = [...from].map((ad) => count(ad.total_views)).sort((a, b) => a - b)
    [Math.max(0, Math.floor(from.length * 0.95) - 1)] ?? Infinity
  const isPopular = (ad) => from.length >= 20 && count(ad.total_views) >= popularCutoff
  const preferred = [...from].sort((a, b) =>
    scoreSmartAd(b, { interests, exposure, seed, now }) - scoreSmartAd(a, { interests, exposure, seed, now }))
  const discovery = [...from].sort((a, b) => {
    const av = count(a.total_views) - (a.fresh_30_days ? 1000 : 0)
    const bv = count(b.total_views) - (b.fresh_30_days ? 1000 : 0)
    return av - bv || hash(`${seed}:${a.story_id}`) - hash(`${seed}:${b.story_id}`)
  })
  const result = []
  const chosen = new Set()
  const maxShort = limit === 1 ? (hash(`${seed}:short`) % 10 === 0 ? 1 : 0) : Math.max(1, Math.floor(limit * SMART_AD_POLICY.shortExposureShare))
  const maxPopular = limit === 1 ? (hash(`${seed}:popular`) % 20 === 0 ? 1 : 0) :
    (hash(`${seed}:popular`) % 2 === 0 ? 1 : 0)
  let shorts = 0
  let popular = 0
  const take = (list) => {
    for (const story of list) {
      const id = String(story.story_id)
      if (chosen.has(id)) continue
      const short = story.story_kind === 'short'
      const top = isPopular(story)
      if (short && shorts >= maxShort) continue
      if (top && popular >= maxPopular) continue
      chosen.add(id)
      result.push(story)
      if (short) shorts += 1
      if (top) popular += 1
      return true
    }
    return false
  }
  const plan = limit === 1 ? ['preferred'] :
    ['preferred', 'discovery', 'preferred', 'discovery', 'preferred', 'discovery',
      'preferred', 'preferred', 'preferred', 'preferred']
  for (const source of plan) take(source === 'preferred' ? preferred : discovery)
  // Do not leave a placement empty when every available story is short or popular.
  // Exposure shares are soft targets rather than an eligibility ban.
  if (result.length < limit) {
    for (const story of preferred) {
      if (result.length >= limit) break
      if (chosen.has(String(story.story_id))) continue
      chosen.add(String(story.story_id))
      result.push(story)
    }
  }
  return result
}

export function smartAdQueueKey(readerKey, placement, slotKey) {
  if (!SMART_AD_PLACEMENTS.includes(placement)) throw new RangeError('Unknown Smart Ad placement')
  return `${readerKey}:${placement}:${slotKey}`
}
