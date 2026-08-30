import { supabase } from '../config/supabase.js'

const POST_INTEREST_SIGNALS = new Set([
  'reaction',
  'comment',
  'echo',
])

const DIRECT_INTEREST_SIGNALS = new Set([
  'hashtag_click',
  'search',
])

function normalizeTagKey(value) {
  return String(value || '')
    .trim()
    .replace(/^#+/, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_]/gu, '')
    .slice(0, 64)
}

export async function recordPostHashtagInterestSignalSafely({
  userId,
  postId,
  signal,
}) {
  const normalizedUserId = String(userId || '').trim()
  const normalizedPostId = String(postId || '').trim()
  const normalizedSignal = String(signal || '').trim().toLowerCase()

  if (
    !normalizedUserId ||
    !normalizedPostId ||
    !POST_INTEREST_SIGNALS.has(normalizedSignal)
  ) {
    return 0
  }

  try {
    const { data, error } = await supabase.rpc(
      'apply_user_post_hashtag_interest_signal',
      {
        p_user_id: normalizedUserId,
        p_post_id: normalizedPostId,
        p_signal: normalizedSignal,
      }
    )

    if (error) throw error

    return Math.max(0, Number(data || 0))
  } catch (error) {
    console.error('POST HASHTAG INTEREST SIGNAL ERROR:', {
      userId: normalizedUserId,
      postId: normalizedPostId,
      signal: normalizedSignal,
      message: error?.message || String(error),
    })

    return 0
  }
}

export async function recordHashtagInterestSignalSafely({
  userId,
  tag,
  signal,
}) {
  const normalizedUserId = String(userId || '').trim()
  const tagKey = normalizeTagKey(tag)
  const normalizedSignal = String(signal || '').trim().toLowerCase()

  if (
    !normalizedUserId ||
    !tagKey ||
    !DIRECT_INTEREST_SIGNALS.has(normalizedSignal)
  ) {
    return 0
  }

  try {
    const { data: hashtag, error: hashtagError } = await supabase
      .from('author_hashtags')
      .select('id')
      .eq('tag_key', tagKey)
      .gt('usage_count', 0)
      .maybeSingle()

    if (hashtagError) throw hashtagError
    if (!hashtag?.id) return 0

    const { data, error } = await supabase.rpc(
      'apply_user_hashtag_interest_signal',
      {
        p_user_id: normalizedUserId,
        p_hashtag_id: hashtag.id,
        p_signal: normalizedSignal,
      }
    )

    if (error) throw error

    const row = Array.isArray(data) ? data[0] : data
    return Math.max(0, Number(row?.interest_score || 0))
  } catch (error) {
    console.error('HASHTAG INTEREST SIGNAL ERROR:', {
      userId: normalizedUserId,
      tag: tagKey,
      signal: normalizedSignal,
      message: error?.message || String(error),
    })

    return 0
  }
}
