import { supabase } from '../config/supabase.js'


const ADULT_CATEGORY_KEYS = [
  'adult',
  'sexual',
  'sex',
  'porn',
  'nsfw',
  'erotic',
  'obscene',
  'profanity',
  'vulgar',
  'explicit',
  'អាសអាភាស',
  'ផ្លូវភេទ',
  'កាម',
  'ពាក្យជេរ',
]

const SAFE_KHMER_CONTEXT_PHRASES = [
  'ក្តោបក្តាប់',
  'ក្តោបក្តាប់ទ្រព្យសម្បត្តិ',
  'ក្តីឈឺចាប់',
  'ក្តីស្រឡាញ់',
  'ក្តីសង្ឃឹម',
  'ក្តីសុខ',
  'ក្តីស្រមៃ',
  'ថ្លុកឈាម',
  'ឈាមត្រជាក់',
  'ឈឺចាប់',
  'បាញ់ប្រហារ',
  'ម៉ាហ្វៀ',
  'មុខជំនួញងងឹត',
  'អធិរាជកាំភ្លើង',
  'ឃោរឃៅ',
  'ប្រលោមលោក',
  'សាច់រឿង',
  'តួអង្គ',
]

function cleanText(value) {
  return String(value || '').trim()
}

function normalizeContent(value) {
  return cleanText(value).normalize('NFC').toLowerCase().replace(/\s+/g, ' ')
}

function normalizeCategory(value) {
  return normalizeContent(value).replace(/[_-]+/g, ' ')
}

function hasKhmer(value) {
  return /[\u1780-\u17FF]/.test(String(value || ''))
}

function khmerBaseLength(value) {
  return (String(value || '').match(/[\u1780-\u17A2\u17A5-\u17B3]/g) || []).length
}

function shouldCheckCategory(item) {
  const category = normalizeCategory(item?.category)
  return ADULT_CATEGORY_KEYS.some((key) => category.includes(normalizeContent(key)))
}

function shouldSkipShortKhmerWord(word) {
  return hasKhmer(word) && khmerBaseLength(word) < 3
}

function isSafeKhmerContext(context) {
  return SAFE_KHMER_CONTEXT_PHRASES.some((phrase) => context.includes(normalizeContent(phrase)))
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getContext(text, start, end) {
  const from = Math.max(0, start - 80)
  const to = Math.min(text.length, end + 80)
  return text.slice(from, to).trim()
}

function shouldIgnoreMatch(context, word) {
  if (shouldSkipShortKhmerWord(word)) return true
  if (hasKhmer(word) && isSafeKhmerContext(context)) return true
  return false
}

function findKhmerMatches(text, word) {
  const matches = []
  let index = 0

  while (index <= text.length) {
    const foundIndex = text.indexOf(word, index)
    if (foundIndex === -1) break

    const endIndex = foundIndex + word.length
    const context = getContext(text, foundIndex, endIndex)

    if (!shouldIgnoreMatch(context, word)) {
      matches.push(context)
    }

    index = endIndex
  }

  return matches
}

function findLatinMatches(text, word) {
  const matches = []
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(word)}(?=$|[^a-z0-9])`, 'gi')

  for (const match of text.matchAll(pattern)) {
    const prefixLength = match[1]?.length || 0
    const start = match.index + prefixLength
    const end = start + word.length
    const context = getContext(text, start, end)

    if (!shouldIgnoreMatch(context, word)) {
      matches.push(context)
    }
  }

  return matches
}

function findMatchesWithContext(text, word) {
  if (!text || !word) return []
  if (hasKhmer(word)) return findKhmerMatches(text, word)
  return findLatinMatches(text, word)
}

export async function findBlockedWordsInContent(fields = []) {
  const text = normalizeContent(
    fields
      .map((field) => field?.value || '')
      .filter(Boolean)
      .join(' ')
  )

  if (!text) return []

  const { data, error } = await supabase
    .from('blocked_words')
    .select('id, word, normalized_word, category, severity')
    .eq('is_active', true)

  if (error) throw error

  return (data || [])
    .filter(shouldCheckCategory)
    .map((item) => {
      const blockedWord = normalizeContent(item.normalized_word || item.word)
      const contexts = findMatchesWithContext(text, blockedWord)

      return {
        id: item.id,
        word: item.word,
        category: item.category,
        severity: item.severity,
        count: contexts.length,
        contexts: contexts.slice(0, 5),
      }
    })
    .filter((item) => item.count > 0)
}

export function blockedWordsWarningPayload(matches = []) {
  return {
    ok: false,
    code: 'BLOCKED_WORDS_FOUND',
    message: 'Your content contains restricted adult or profane words. Please remove or edit these words before publishing.',
    blocked_words_found: matches,
  }
}
