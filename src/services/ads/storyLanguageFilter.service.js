const LANGUAGE_ALIASES = Object.freeze({
  kh: 'km',
  km: 'km',
  khmer: 'km',
  cambodian: 'km',
  en: 'en',
  english: 'en',
  zh: 'zh',
  chinese: 'zh',
  mandarin: 'zh',
  ko: 'ko',
  kr: 'ko',
  korean: 'ko',
  ja: 'ja',
  jp: 'ja',
  japanese: 'ja'
})

export function normalizeStoryLanguage(value) {
  if (typeof value !== 'string') return null
  const cleaned = value.trim().toLowerCase().replace(/_/g, '-')
  const primary = cleaned.split('-')[0]
  return LANGUAGE_ALIASES[cleaned] || LANGUAGE_ALIASES[primary] || null
}

export function filterAutoAdStoriesByLanguage(eligibleStories, selectedStoryLanguage) {
  if (!Array.isArray(eligibleStories)) return []
  const language = normalizeStoryLanguage(selectedStoryLanguage)
  if (!language) return []

  return eligibleStories.filter((candidate) => {
    const storyLanguage = candidate?.story_language ?? candidate?.storyLanguage ??
      candidate?.story?.story_language ?? candidate?.story?.storyLanguage ??
      candidate?.language ?? candidate?.story?.language
    return normalizeStoryLanguage(storyLanguage) === language
  })
}

export function storyLanguageQueueKey(selectedStoryLanguage) {
  const language = normalizeStoryLanguage(selectedStoryLanguage)
  return `story-language:${language || 'none'}`
}
