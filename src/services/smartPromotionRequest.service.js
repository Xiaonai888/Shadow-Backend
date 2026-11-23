const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LANGUAGE_ALIASES = Object.freeze({
  km: 'km', khmer: 'km', kh: 'km',
  en: 'en', english: 'en',
  zh: 'zh', chinese: 'zh',
  ja: 'ja', japanese: 'ja',
  ko: 'ko', korean: 'ko',
})
const MAX_INTERESTS = 24
const MAX_EXCLUSIONS = 150

export class SmartPromotionInputError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'SmartPromotionInputError'
    this.status = status
  }
}

export function parseSmartPromotionRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new SmartPromotionInputError('Invalid promotion request')
  }
  const language = typeof body.story_language === 'string'
    ? LANGUAGE_ALIASES[body.story_language.trim().toLowerCase()]
    : null
  if (!language) throw new SmartPromotionInputError('Invalid Story Language')

  const sourceInterests = body.interests == null ? {} : body.interests
  if (!sourceInterests || typeof sourceInterests !== 'object' || Array.isArray(sourceInterests)) {
    throw new SmartPromotionInputError('Invalid promotion interests')
  }
  const entries = Object.entries(sourceInterests)
  if (entries.length > MAX_INTERESTS) throw new SmartPromotionInputError('Too many promotion interests')
  const interests = Object.create(null)
  for (const [rawName, rawWeight] of entries) {
    const name = rawName.trim().toLowerCase()
    const weight = Number(rawWeight)
    if (!name || name.length > 60 || !Number.isFinite(weight) || weight < 0 || weight > 40) {
      throw new SmartPromotionInputError('Invalid promotion interest')
    }
    interests[name] = weight
  }

  const sourceExcluded = body.exclude_story_ids == null ? [] : body.exclude_story_ids
  if (!Array.isArray(sourceExcluded) || sourceExcluded.length > MAX_EXCLUSIONS) {
    throw new SmartPromotionInputError('Invalid promotion exclusions')
  }
  const excludedIds = new Set()
  for (const rawId of sourceExcluded) {
    if (typeof rawId !== 'string') throw new SmartPromotionInputError('Invalid promotion story ID')
    const id = rawId.trim().toLowerCase()
    if (!UUID.test(id)) throw new SmartPromotionInputError('Invalid promotion story ID')
    excludedIds.add(id)
  }

  return {
    language,
    interests,
    excludeStoryIds: [...excludedIds],
  }
}
