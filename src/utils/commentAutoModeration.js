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

export async function findBlockedWordsInComment(text) {
  const normalizedText = normalizeContent(text)

  if (!normalizedText) return []

  const { data, error } = await supabase
    .from('blocked_words')
    .select('id, word, normalized_word, category, severity')
    .eq('is_active', true)

  if (error) throw error

  return (data || [])
    .map((item) => {
      const blockedWord = normalizeContent(item.normalized_word || item.word)
      const count = countOccurrences(normalizedText, blockedWord)

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

export async function saveAutoHiddenCommentLog({ commentId, storyId, userId, text, matchedWords }) {
  const { error } = await supabase
    .from('reader_comment_auto_hide_logs')
    .insert({
      comment_id: commentId,
      story_id: storyId,
      user_id: userId,
      matched_words: matchedWords,
      comment_text: text,
      status: 'hidden',
      source: 'auto_block_words',
    })

  if (error) throw error
}

export function autoHiddenCommentPayload(matchedWords = []) {
  return {
    ok: false,
    code: 'COMMENT_AUTO_HIDDEN',
    message: 'Your comment was hidden because it may contain restricted words. Please edit your comment and try again.',
    matched_words: matchedWords,
  }
}
