import { supabase } from '../config/supabase.js'

function cleanText(value) {
  return String(value || '').trim()
}

function normalizeContent(value) {
  return cleanText(value).toLowerCase().replace(/\s+/g, ' ')
}

function countOccurrences(text, word) {
  if (!text || !word) return 0

  let count = 0
  let index = 0

  while (index <= text.length) {
    const foundIndex = text.indexOf(word, index)
    if (foundIndex === -1) break

    count += 1
    index = foundIndex + word.length
  }

  return count
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
      const count = countOccurrences(text, blockedWord)

      return {
        id: item.id,
        word: item.word,
        category: item.category,
        severity: item.severity,
        count,
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
