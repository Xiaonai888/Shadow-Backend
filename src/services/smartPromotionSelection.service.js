import { scoreSmartAd } from './smartAdSelection.service.js'
import { selectDiverseSmartAdCandidates } from './smartAdDiversityPolicy.service.js'

const MAX_OFFERS = 3

function asMap(value) {
  if (value instanceof Map) return value
  if (value && typeof value === 'object' && !Array.isArray(value)) return new Map(Object.entries(value))
  return new Map()
}

function normalizeInterests(value) {
  const clean = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return clean
  for (const [rawGenre, rawWeight] of Object.entries(value).slice(0, 24)) {
    const genre = String(rawGenre).trim().toLowerCase().slice(0, 60)
    const weight = Number(rawWeight)
    if (genre && Number.isFinite(weight)) clean[genre] = Math.max(0, Math.min(40, weight))
  }
  return clean
}

export function selectSmartPromotionOffers({
  candidates = [],
  language = 'km',
  readerKey = 'anonymous',
  slotKey = '',
  interests = {},
  ownedCounts = new Map(),
  promotionHistory = new Map(),
  adHistory = new Map(),
  selectedThisSlotIds = [],
  exposure = {},
  diamondRate = 10,
  excludeStoryIds = [],
  now = Date.now(),
} = {}) {
  const rate = Number(diamondRate)
  if (!Number.isSafeInteger(rate) || rate < 2) throw new RangeError('Invalid diamond rate')
  const owned = asMap(ownedCounts)
  const combinedHistory = new Map([...asMap(adHistory), ...asMap(promotionHistory)])
  const blocked = new Set((Array.isArray(excludeStoryIds) ? excludeStoryIds : []).map(String))
  const eligible = new Map()
  for (const story of Array.isArray(candidates) ? candidates : []) {
    const id = String(story?.story_id || '').toLowerCase()
    const total = Number(story?.locked_episode_count)
    const published = Number(story?.total_episodes)
    const purchased = Number(owned.get(id) || 0)
    if (
      !id || blocked.has(id) || eligible.has(id) ||
      story?.promotion_eligible !== true || story?.story_language !== language ||
      !story?.first_episode_id || !story?.cover_url ||
      !Number.isSafeInteger(total) || total < 5 ||
      !Number.isSafeInteger(published) || published < 10 ||
      !Number.isSafeInteger(purchased) || purchased < 0
    ) continue
    const remaining = Math.max(0, total - purchased)
    if (!remaining) continue
    const original = remaining * rate
    const price = Math.ceil(original / 2)
    if (!Number.isSafeInteger(original) || !Number.isSafeInteger(price)) continue
    eligible.set(id, {
      ...story,
      locked_episode_count: remaining,
      total_locked_episode_count: total,
      owned_locked_episode_count: purchased,
      original_price_diamonds: original,
      discounted_price_diamonds: price,
      discount_percent: 50,
      promotion_eligible: true,
      story_kind: story.story_kind || 'novel',
    })
  }

  if (!eligible.size) return []
  const pinned = []
  const selected = new Set()
  for (const rawId of Array.isArray(selectedThisSlotIds) ? selectedThisSlotIds : []) {
    const id = String(rawId || '').toLowerCase()
    const offer = eligible.get(id)
    if (!offer || selected.has(id)) continue
    pinned.push(offer)
    selected.add(id)
    if (pinned.length >= MAX_OFFERS) return pinned
  }
  const remaining = [...eligible.values()].filter((story) => !selected.has(story.story_id))
  const seed = `${readerKey}:specialPromotion:${language}:${slotKey}`
  const scored = selectDiverseSmartAdCandidates({
    candidates: remaining,
    limit: MAX_OFFERS - pinned.length,
    recentHistory: combinedHistory,
    seed,
    now,
    shortShare: 0.10,
    allowRecentFallback: true,
    preferredScore: (story) => scoreSmartAd(story, {
      interests: normalizeInterests(interests), exposure, seed, now,
    }),
  })
  return [...pinned, ...scored].slice(0, MAX_OFFERS)
}
