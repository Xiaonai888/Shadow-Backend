import { normalizeStoryLanguage } from './ads/storyLanguageFilter.service.js'

const STORY_LANGUAGE_FILTERS = Object.freeze({
  km: 'story_language.ilike.khmer,story_language.ilike.km,story_language.ilike.kh,story_language.ilike.cambodian,story_language.ilike.km-*,story_language.ilike.kh-*,story_language.ilike.km_*,story_language.ilike.kh_*',
  en: 'story_language.ilike.english,story_language.ilike.en,story_language.ilike.en-*,story_language.ilike.en_*',
  zh: 'story_language.ilike.chinese,story_language.ilike.mandarin,story_language.ilike.zh,story_language.ilike.cn,story_language.ilike.zh-*,story_language.ilike.zh_*',
  ja: 'story_language.ilike.japanese,story_language.ilike.ja,story_language.ilike.jp,story_language.ilike.ja-*,story_language.ilike.ja_*',
  ko: 'story_language.ilike.korean,story_language.ilike.ko,story_language.ilike.kr,story_language.ilike.ko-*,story_language.ilike.ko_*',
})

export function getAdminStoryLanguage(value = 'all') {
  if (value === undefined || value === null || value === '') return 'all'
  if (typeof value !== 'string' || value.length > 32) {
    const error = new Error('Invalid Story Language')
    error.status = 400
    throw error
  }
  const input = value.trim().toLowerCase()
  if (input === 'all') return 'all'
  const language = normalizeStoryLanguage(input)
  if (language && Object.hasOwn(STORY_LANGUAGE_FILTERS, language)) return language
  const error = new Error('Unsupported Story Language')
  error.status = 400
  throw error
}

export function applyAdminStoryLanguageFilter(query, language) {
  if (language === 'all') return query
  if (!Object.hasOwn(STORY_LANGUAGE_FILTERS, language)) {
    const error = new Error('Unsupported Story Language')
    error.status = 400
    throw error
  }
  return query.or(STORY_LANGUAGE_FILTERS[language])
}
