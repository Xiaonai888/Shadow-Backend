import { supabase } from '../config/supabase.js'

const MAX_BLOCK_MILLISECONDS = 30 * 24 * 60 * 60 * 1000

function toTimestamp(value) {
  const timestamp = new Date(value || '').getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}

function publicBlock(block) {
  const expiresAt = block?.expires_at || null
  const retryAfterSeconds = expiresAt
    ? Math.max(
        1,
        Math.ceil(
          (toTimestamp(expiresAt) - Date.now()) / 1000
        )
      )
    : 0

  return {
    id: block.id,
    user_id: block.user_id,
    reason: block.reason || 'Other',
    note: block.note || '',
    expires_at: expiresAt,
    restriction_until: expiresAt,
    retry_after_seconds: retryAfterSeconds,
    is_permanent: false,
  }
}

async function deactivateBlocks(blockIds) {
  const ids = [...new Set(blockIds.filter(Boolean))]

  if (!ids.length) return

  const { error } = await supabase
    .from('reader_comment_blocks')
    .update({
      is_active: false,
      updated_at: new Date().toISOString(),
    })
    .in('id', ids)

  if (error) throw error
}

async function capBlockExpiration(block, expiresAt) {
  const { data, error } = await supabase
    .from('reader_comment_blocks')
    .update({
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', block.id)
    .select(
      'id, user_id, reason, note, expires_at, is_active, created_at'
    )
    .single()

  if (error) throw error

  return data
}

export async function getActiveReaderCommentBlock(userId) {
  if (!userId) return null

  const { data, error } = await supabase
    .from('reader_comment_blocks')
    .select(
      'id, user_id, reason, note, expires_at, is_active, created_at'
    )
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) throw error

  const now = Date.now()
  const maximumExpiresAt =
    now + MAX_BLOCK_MILLISECONDS
  let activeBlock = null
  const blocksToDeactivate = []

  for (const block of data || []) {
    const expiresAt = toTimestamp(block.expires_at)

    if (!expiresAt || expiresAt <= now) {
      blocksToDeactivate.push(block.id)
      continue
    }

    if (activeBlock) {
      blocksToDeactivate.push(block.id)
      continue
    }

    if (expiresAt > maximumExpiresAt) {
      activeBlock = await capBlockExpiration(
        block,
        new Date(maximumExpiresAt).toISOString()
      )
      continue
    }

    activeBlock = block
  }

  await deactivateBlocks(blocksToDeactivate)

  return activeBlock
    ? publicBlock(activeBlock)
    : null
}

export function readerCommentBlockedPayload(block) {
  const publicData = publicBlock(block)

  return {
    ok: false,
    code: 'READER_COMMENT_BLOCKED',
    message:
      'Your commenting access is temporarily restricted.',
    retry_after_seconds:
      publicData.retry_after_seconds,
    restriction_until:
      publicData.restriction_until,
    comment_block: publicData,
  }
}
