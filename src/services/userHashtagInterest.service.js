import { supabase } from '../config/supabase.js'

const POST_INTEREST_SIGNALS = new Set([
  'reaction',
  'comment',
  'echo',
])

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
