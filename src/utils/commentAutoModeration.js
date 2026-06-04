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

function matchedWordsText(words) {
  if (!Array.isArray(words) || !words.length) return ''
  return words
    .map((item) => `${item.word || ''}${item.count ? ` ×${item.count}` : ''}`)
    .filter(Boolean)
    .join(', ')
}

async function getUser(userId) {
  if (!userId) return null

  const { data, error } = await supabase
    .from('users')
    .select('id, name, username, email')
    .eq('id', userId)
    .maybeSingle()

  if (error) throw error
  return data
}

async function createReaderRecord({ action, userId, reason = '', note = '', actor = 'System', details = '', expiresAt = null }) {
  const user = await getUser(userId)

  const { error } = await supabase
    .from('reader_comment_block_logs')
    .insert({
      action,
      user_id: userId,
      reader_name: user?.name || user?.username || 'Reader',
      reader_email: user?.email || '',
      reason,
      note,
      actor,
      details,
      expires_at: expiresAt,
    })

  if (error) console.error('CREATE READER RECORD ERROR:', error)
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

  await createReaderRecord({
    action: 'AUTO_HIDE_COMMENT',
    userId,
    reason: 'Blocked words',
    actor: 'System',
    details: `Auto hidden reader comment. Matched: ${matchedWordsText(matchedWords)}`,
  })
}

export function autoHiddenCommentPayload(matchedWords = []) {
  return {
    ok: false,
    code: 'COMMENT_AUTO_HIDDEN',
    message: 'Your comment was hidden because it may contain restricted words. Please edit your comment and try again.',
    matched_words: matchedWords,
  }
}
