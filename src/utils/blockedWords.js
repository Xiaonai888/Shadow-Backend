import { supabase } from '../config/supabase.js'

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

const FICTION_CONTEXT_HINTS = [
  'រឿង',
  'ប្រលោមលោក',
  'សាច់រឿង',
  'តួអង្គ',
  'ភាគ',
  'ជំពូក',
  'ម៉ាហ្វៀ',
  'ត្រកូល',
  'អាណាចក្រ',
  'អ្នកប្រុស',
  'នាង',
  'គេ',
  'លោក',
]

const DIRECT_THREAT_HINTS = [
  'ខ្ញុំនឹង',
  'យើងនឹង',
  'អញនឹង',
  'ទៅសម្លាប់',
  'សម្លាប់អ្នក',
  'បាញ់អ្នក',
  'គំរាម',
  'ធ្វើឱ្យអ្នក',
]

function cleanText(value) {
  return String(value || '').trim()
}

function normalizeContent(value) {
  return cleanText(value).normalize('NFC').toLowerCase().replace(/\s+/g, ' ')
}

function hasKhmer(value) {
  return /[\u1780-\u17FF]/.test(String(value || ''))
}

function khmerBaseLength(value) {
  return (String(value || '').match(/[\u1780-\u17A2\u17A5-\u17B3]/g) || []).length
}

function normalizeCategory(value) {
  return normalizeContent(value).replace(/[_-]+/g, ' ')
}

function isViolenceCategory(item) {
  const category = normalizeCategory(item?.category)
  return category.includes('violence') || category.includes('violent') || category.includes('weapon')
}

function isDirectThreatContext(context) {
  return DIRECT_THREAT_HINTS.some((phrase) => context.includes(normalizeContent(phrase)))
}

function isFictionContext(context) {
  return FICTION_CONTEXT_HINTS.some((phrase) => context.includes(normalizeContent(phrase)))
}

function isSafeKhmerContext(context) {
  return SAFE_KHMER_CONTEXT_PHRASES.some((phrase) => context.includes(normalizeContent(phrase)))
}

function shouldSkipShortKhmerWord(word) {
  return hasKhmer(word) && khmerBaseLength(word) < 2
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getContext(text, start, end) {
  const from = Math.max(0, start - 70)
  const to = Math.min(text.length, end + 70)
  return text.slice(from, to).trim()
}

function shouldIgnoreMatch(context, word, item) {
  if (shouldSkipShortKhmerWord(word)) return true
  if (hasKhmer(word) && isSafeKhmerContext(context)) return true
  if (isViolenceCategory(item) && isFictionContext(context) && !isDirectThreatContext(context)) return true
  return false
}

function findKhmerMatches(text, word, item) {
  const matches = []
  let index = 0

  while (index <= text.length) {
    const foundIndex = text.indexOf(word, index)
    if (foundIndex === -1) break

    const endIndex = foundIndex + word.length
    const context = getContext(text, foundIndex, endIndex)

    if (!shouldIgnoreMatch(context, word, item)) {
      matches.push(context)
    }

    index = endIndex
  }

  return matches
}

function findLatinMatches(text, word, item) {
  const matches = []
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(word)}(?=$|[^a-z0-9])`, 'gi')

  for (const match of text.matchAll(pattern)) {
    const prefixLength = match[1]?.length || 0
    const start = match.index + prefixLength
    const end = start + word.length
    const context = getContext(text, start, end)

    if (!shouldIgnoreMatch(context, word, item)) {
      matches.push(context)
    }
  }

  return matches
}

function findMatchesWithContext(text, word, item) {
  if (!text || !word) return []
  if (hasKhmer(word)) return findKhmerMatches(text, word, item)
  return findLatinMatches(text, word, item)
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
    .map((item) => {
      const blockedWord = normalizeContent(item.normalized_word || item.word)
      const contexts = findMatchesWithContext(text, blockedWord, item)

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
    message: 'Your content contains restricted words that may be related to adult, violent, or unsafe content. Please remove or edit these words before publishing.',
    blocked_words_found: matches,
  }
}
