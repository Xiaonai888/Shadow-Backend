import { supabase } from '../config/supabase.js'

function publicBlock(block) {
  return {
    id: block.id,
    user_id: block.user_id,
    reason: block.reason || 'Other',
    note: block.note || '',
    expires_at: block.expires_at,
    is_permanent: !block.expires_at,
  }
}

export async function getActiveReaderCommentBlock(userId) {
  if (!userId) return null

  const { data, error } = await supabase
    .from('reader_comment_blocks')
    .select('id, user_id, reason, note, expires_at, is_active')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(5)

  if (error) throw error

  const now = Date.now()
  const activeBlock = (data || []).find((block) => {
    if (!block.expires_at) return true
    return new Date(block.expires_at).getTime() > now
  })

  const expiredBlocks = (data || []).filter((block) => {
    if (!block.expires_at) return false
    return new Date(block.expires_at).getTime() <= now
  })

  if (expiredBlocks.length) {
    await supabase
      .from('reader_comment_blocks')
      .update({
        is_active: false,
        updated_at: new Date().toISOString(),
      })
      .in('id', expiredBlocks.map((block) => block.id))
  }

  return activeBlock ? publicBlock(activeBlock) : null
}

export function readerCommentBlockedPayload(block) {
  return {
    ok: false,
    code: 'READER_COMMENT_BLOCKED',
    message: block.expires_at
      ? 'Your commenting access is temporarily restricted.'
      : 'Your commenting access is restricted.',
    comment_block: publicBlock(block),
  }
}
