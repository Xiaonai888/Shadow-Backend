import { supabase } from '../config/supabase.js'

function cleanText(value) {
  return String(value || '').normalize('NFC').trim().replace(/\s+/g, ' ')
}

function normalizeText(value) {
  return cleanText(value).toLowerCase()
}

function hasKhmer(value) {
  return /[\u1780-\u17FF]/.test(String(value || ''))
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function countOccurrences(text, word) {
  if (!text || !word) return 0

  if (hasKhmer(word)) {
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

  const pattern = new RegExp(
    `(^|[^\\p{L}\\p{N}])${escapeRegExp(word)}(?=$|[^\\p{L}\\p{N}])`,
    'giu'
  )

  return [...text.matchAll(pattern)].length
}

export async function findAuthorBlockedWordsInComment({
  authorPageId,
  authorUserId,
  text,
}) {
  const normalizedText = normalizeText(text)

  if (!authorPageId || !authorUserId || !normalizedText) return []

  const { data, error } = await supabase
    .from('author_blocked_words')
    .select('id, word, normalized_word')
    .eq('author_page_id', String(authorPageId))
    .eq('author_user_id', String(authorUserId))
    .eq('is_active', true)

  if (error) throw error

  return (data || [])
    .map((item) => {
      const blockedWord = normalizeText(item.normalized_word || item.word)
      const count = countOccurrences(normalizedText, blockedWord)

      return {
        id: item.id,
        word: item.word,
        count,
      }
    })
    .filter((item) => item.count > 0)
}

export async function saveAuthorHiddenCommentReview({
  authorPageId,
  authorUserId,
  commentId,
  storyId,
  episodeId = null,
  readerUserId,
  text,
  matchedWords,
}) {
  const { error } = await supabase
    .from('author_hidden_comment_reviews')
    .insert({
      author_page_id: String(authorPageId),
      author_user_id: String(authorUserId),
      comment_id: String(commentId),
      story_id: String(storyId),
      episode_id: episodeId ? String(episodeId) : null,
      reader_user_id: String(readerUserId),
      matched_words: matchedWords,
      comment_text: cleanText(text),
      status: 'hidden',
    })

  if (error) throw error
}

export function authorHiddenCommentPayload(matchedWords = []) {
  return {
    ok: false,
    code: 'AUTHOR_COMMENT_AUTO_HIDDEN',
    message: 'Your comment was hidden by the author’s comment protection rules and is waiting for review.',
    matched_words: [],
    matched_count: matchedWords.length,
  }
}
