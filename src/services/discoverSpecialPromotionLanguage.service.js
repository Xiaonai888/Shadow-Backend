import {
  getDiscoverPromotionLanguageRotation,
  normalizeDiscoverPromotionLanguage,
} from './discoverPromotionLanguageRotation.service.js'

const MIN_LOCKED_EPISODES = 5

function validInteger(value, minimum) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= minimum
}

function validateStoryOffer(item, language, expiresAt) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error('Invalid special promotion story')
  }

  const storyId = String(item.story_id || '').trim()
  const title = String(item.story_title || '').trim()
  const coverUrl = String(item.cover_url || '').trim()
  const count = Number(item.locked_episode_count)
  const original = Number(item.original_price_diamonds)
  const discounted = Number(item.discounted_price_diamonds)
  const expiry = Date.parse(String(item.expires_at || ''))

  if (
    !storyId || !title || !coverUrl ||
    normalizeDiscoverPromotionLanguage(item.story_language) !== language ||
    !validInteger(count, MIN_LOCKED_EPISODES) ||
    !validInteger(original, count * 2) ||
    !validInteger(discounted, count) ||
    discounted !== Math.ceil(original / 2) ||
    expiry !== expiresAt ||
    Number(item.discount_percent) !== 50
  ) {
    throw new Error('Invalid special promotion price, language, or expiry')
  }

  return {
    ...item,
    id: `special-${storyId}`,
    story_id: storyId,
    story_title: title,
    cover_url: coverUrl,
    profile_image_url: coverUrl,
    story_language: language,
    locked_episode_count: count,
    original_price_diamonds: original,
    discounted_price_diamonds: discounted,
    discount_percent: 50,
    expires_at: new Date(expiresAt).toISOString(),
  }
}

export function getCurrentDiscoverSpecialPromotionsForLanguage(language) {
  return getDiscoverPromotionLanguageRotation('story', language, validateStoryOffer)
}
