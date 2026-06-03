import { supabase } from '../config/supabase.js'

function cleanText(value) {
  return String(value || '').trim()
}

function normalizeContent(value) {
  return cleanText(value).toLowerCase().replace(/\s+/g, ' ')
}

function uniqueMatches(matches) {
  const seen = new Set()

  return matches.filter((item) => {
    const key = item.normalized_word || item.word
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
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

  const matches = (data || []).filter((item) => {
    const blockedWord = normalizeContent(item.normalized_word || item.word)
    if (!blockedWord) return false
    return text.includes(blockedWord)
  })

  return uniqueMatches(matches).map((item) => ({
    id: item.id,
    word: item.word,
    category: item.category,
    severity: item.severity,
  }))
}

export function blockedWordsWarningPayload(matches = []) {
  return {
    ok: false,
    code: 'BLOCKED_WORDS_FOUND',
    message: 'Your content contains restricted words that may be related to adult, violent, or unsafe content. Please remove or edit these words before publishing.',
    blocked_words_found: matches,
  }
}
