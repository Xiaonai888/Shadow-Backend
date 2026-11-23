import { supabase } from '../config/supabase.js'
import { readSmartPromotionCandidateById, readSmartPromotionDiamondRate } from './smartPromotionCatalog.service.js'
import { readSmartPromotionOwnedCounts } from './smartPromotionReaderState.service.js'
import {
  createSmartPromotionOfferToken,
  verifySmartPromotionOfferToken,
  SmartPromotionOfferError,
} from './smartPromotionOfferToken.service.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function authorizeSmartPromotionPurchase({
  readerHash,
  readerId,
  storyId,
  storyLanguage,
  offerToken,
  expectedPrice,
  db = supabase,
  now = Date.now(),
  sources = {},
} = {}) {
  const id = String(storyId || '').trim().toLowerCase()
  const reader = String(readerId || '').trim().toLowerCase()
  if (!UUID.test(id) || !UUID.test(reader)) {
    throw new SmartPromotionOfferError('Reader login is required', 'PROMOTION_CHANGED', 401)
  }
  const token = verifySmartPromotionOfferToken(offerToken, {
    readerHash, storyId: id, language: storyLanguage, now,
  })
  const fetchCandidate = sources.readCandidate || readSmartPromotionCandidateById
  const fetchRate = sources.readRate || readSmartPromotionDiamondRate
  const fetchOwned = sources.readOwned || readSmartPromotionOwnedCounts
  const [candidate, diamondRate, owned] = await Promise.all([
    fetchCandidate(id, token.language, { db }),
    fetchRate({ db, now }),
    fetchOwned(reader, [id], { db }),
  ])
  if (!candidate || candidate.promotion_eligible !== true ||
      candidate.story_language !== token.language || candidate.story_id !== id ||
      Number(candidate.total_episodes) < 10 || Number(candidate.locked_episode_count) < 5) {
    throw new SmartPromotionOfferError('This story is no longer eligible', 'PROMOTION_CHANGED')
  }
  const total = Number(candidate.locked_episode_count)
  const rate = Number(diamondRate)
  const count = Number(owned?.get?.(id) || 0)
  if (!Number.isSafeInteger(rate) || rate < 2 ||
      !Number.isSafeInteger(count) || count < 0 || count > total) {
    throw new SmartPromotionOfferError('Special Promotion price is temporarily unavailable', 'PROMOTION_CHANGED')
  }
  const remaining = total - count
  if (remaining <= 0) {
    throw new SmartPromotionOfferError('All eligible episodes are already unlocked', 'PROMOTION_CHANGED')
  }
  const original = remaining * rate
  const price = Math.ceil(original / 2)
  if (!Number.isSafeInteger(price) || !Number.isSafeInteger(original)) {
    throw new SmartPromotionOfferError('Special Promotion price is temporarily unavailable', 'PROMOTION_CHANGED')
  }
  const confirmedPrice = expectedPrice == null ? NaN : Number(expectedPrice)
  if (!Number.isSafeInteger(confirmedPrice) || confirmedPrice !== price ||
      price !== token.price || remaining !== token.lockedCount) {
    const replacement = createSmartPromotionOfferToken({
      readerHash,
      storyId: id,
      language: token.language,
      slotKey: token.slotKey,
      expiresAt: new Date(token.expiresAt).toISOString(),
      price,
      lockedCount: remaining,
    }, { now })
    throw new SmartPromotionOfferError('Please confirm the updated Special Promotion price',
      'PRICE_CONFIRMATION_REQUIRED', 409, {
        locked_episode_count: remaining,
        original_price_diamonds: original,
        discounted_price_diamonds: price,
        offer_token: replacement,
      })
  }
  return {
    story_id: id,
    story_language: token.language,
    locked_episode_count: total,
    original_price_diamonds: total * rate,
    discounted_price_diamonds: Math.ceil(total * rate / 2),
    purchased_locked_episode_count: count,
    current_remaining_episode_count: remaining,
    current_price_diamonds: price,
    expires_at: new Date(token.expiresAt).toISOString(),
    discount_percent: 50,
  }
}
