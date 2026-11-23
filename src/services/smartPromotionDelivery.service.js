import { supabase } from '../config/supabase.js'
import { smartAdCambodiaSlot } from './smartAdEligibility.service.js'
import { readSmartAdRecentHistory } from './smartAdRecentHistory.service.js'
import { readSmartAdExposureTotals } from './smartAdTracking.service.js'
import { readSmartPromotionCatalog, readSmartPromotionDiamondRate } from './smartPromotionCatalog.service.js'
import {
  readSmartPromotionOwnedCounts,
  readSmartPromotionReaderHistory,
  recordSmartPromotionSelections,
} from './smartPromotionReaderState.service.js'
import { selectSmartPromotionOffers } from './smartPromotionSelection.service.js'
import { createSmartPromotionOfferToken } from './smartPromotionOfferToken.service.js'

const MAX_CANDIDATES = 160
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const READER_HASH = /^[0-9a-f]{64}$/

function hash(text) {
  let number = 2166136261
  for (const character of String(text)) {
    number ^= character.charCodeAt(0)
    number = Math.imul(number, 16777619)
  }
  return number >>> 0
}

export function chooseSmartPromotionCandidateSample(catalog, {
  readerHash,
  slotKey,
  interests = {},
  selectedThisSlotIds = [],
  limit = MAX_CANDIDATES,
} = {}) {
  const records = new Map()
  for (const story of Array.isArray(catalog) ? catalog : []) {
    const id = String(story?.story_id || '').toLowerCase()
    if (UUID.test(id) && !records.has(id) && story?.promotion_eligible === true) records.set(id, story)
  }
  const size = Math.max(1, Math.min(MAX_CANDIDATES, Number(limit) || MAX_CANDIDATES))
  const picked = []
  const used = new Set()
  const take = (story) => {
    if (!story || used.has(story.story_id) || picked.length >= size) return
    used.add(story.story_id)
    picked.push(story)
  }

  for (const id of selectedThisSlotIds) take(records.get(String(id).toLowerCase()))
  const remaining = [...records.values()].filter((story) => !used.has(story.story_id))
  const seed = `${readerHash}:${slotKey}:promotion-candidates`
  const interestWeights = interests && typeof interests === 'object' ? interests : {}
  const interestScore = (story) => {
    const genre = String(story.main_genre || story.genre || '').toLowerCase()
    const tags = Array.isArray(story.tags) ? story.tags : []
    const value = Number(interestWeights[genre] || 0)
    return value * 15 + tags.reduce((sum, tag) => sum + Number(interestWeights[String(tag).toLowerCase()] || 0) * 4, 0)
  }
  const interestCount = Math.min(Math.floor((size - picked.length) * 0.5), remaining.length)
  const matched = remaining.filter((story) => interestScore(story) > 0).sort((a, b) =>
    interestScore(b) - interestScore(a) ||
    hash(`${seed}:${a.story_id}`) - hash(`${seed}:${b.story_id}`))
  for (const story of matched.slice(0, interestCount)) take(story)

  const explore = remaining.filter((story) => !used.has(story.story_id)).sort((a, b) =>
    hash(`${seed}:${a.story_id}`) - hash(`${seed}:${b.story_id}`))
  for (const story of explore) take(story)
  return picked
}

export async function getSmartPromotionRotation({
  readerHash,
  readerId = null,
  language = 'km',
  interests = {},
  excludeStoryIds = [],
  db = supabase,
  now = Date.now(),
  sources = {},
} = {}) {
  if (!READER_HASH.test(String(readerHash || ''))) throw new TypeError('Invalid promotion reader identity')
  const slot = smartAdCambodiaSlot(now)
  const readCatalog = sources.readCatalog || readSmartPromotionCatalog
  const readDiamondRate = sources.readDiamondRate || readSmartPromotionDiamondRate
  const readReaderHistory = sources.readReaderHistory || readSmartPromotionReaderHistory
  const readAdHistory = sources.readAdHistory || readSmartAdRecentHistory
  const readOwned = sources.readOwned || readSmartPromotionOwnedCounts
  const readExposure = sources.readExposure || readSmartAdExposureTotals
  const recordSelections = sources.recordSelections || recordSmartPromotionSelections

  const [catalog, diamondRate, readerHistory, adHistory] = await Promise.all([
    readCatalog({ language, db, now }),
    readDiamondRate({ db, now }),
    readReaderHistory(readerHash, slot.slot_key, { db, now }),
    readAdHistory(readerHash, { db, now }),
  ])
  const selectedThisSlotIds = Array.isArray(readerHistory?.selectedThisSlotIds)
    ? readerHistory.selectedThisSlotIds : []
  const sample = chooseSmartPromotionCandidateSample(catalog, {
    readerHash,
    slotKey: slot.slot_key,
    interests,
    selectedThisSlotIds,
  })
  const excluded = new Set(excludeStoryIds.map((id) => String(id).toLowerCase()))
  const allowed = sample.filter((story) => !excluded.has(story.story_id))
  const candidateIds = allowed.map((story) => story.story_id)
  const [ownedCounts, exposure] = await Promise.all([
    readerId ? readOwned(readerId, candidateIds, { db }) : Promise.resolve(new Map()),
    candidateIds.length ? readExposure(candidateIds, { db, now }) : Promise.resolve({}),
  ])
  const promotions = selectSmartPromotionOffers({
    candidates: allowed,
    language,
    readerKey: readerHash,
    slotKey: slot.slot_key,
    interests,
    ownedCounts,
    promotionHistory: readerHistory?.recent || new Map(),
    adHistory,
    selectedThisSlotIds,
    exposure,
    diamondRate,
    excludeStoryIds: [...excluded],
    now,
  }).map((offer) => ({
    ...offer,
    id: `special-${offer.story_id}`,
    slot_start_at: slot.starts_at,
    expires_at: slot.next_rotation_at,
    offer_token: createSmartPromotionOfferToken({
      readerHash,
      storyId: offer.story_id,
      language,
      slotKey: slot.slot_key,
      expiresAt: slot.next_rotation_at,
      price: offer.discounted_price_diamonds,
      lockedCount: offer.locked_episode_count,
    }, { now }),
  }))
  if (promotions.length) {
    await recordSelections(readerHash, slot.slot_key, promotions.map((offer) => offer.story_id), { db, now })
  }

  return {
    ok: true,
    personalized: true,
    language,
    story_language: language,
    promotions,
    promotion: promotions[0] || null,
    slot_key: slot.slot_key,
    slot_start_at: slot.starts_at,
    rotation_key: slot.slot_key,
    expires_at: slot.next_rotation_at,
  }
}
