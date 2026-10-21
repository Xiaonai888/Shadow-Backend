import { supabase } from '../config/supabase.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function getIds(req) {
  return {
    userId: String(req.user?.user_id || '').trim().toLowerCase(),
    targetId: String(req.params?.readerId || '').trim().toLowerCase(),
  }
}

async function getTarget(targetId) {
  const { data, error } = await supabase
    .from('users')
    .select('id, name, username, avatar_url')
    .eq('id', targetId)
    .eq('is_active', true)
    .maybeSingle()

  if (error) throw error
  return data
}

async function changeReaderBlock(req, res, shouldBlock) {
  const { userId, targetId } = getIds(req)

  if (!UUID_PATTERN.test(userId)) {
    return res.status(401).json({ ok: false, message: 'Unauthorized' })
  }

  if (!UUID_PATTERN.test(targetId)) {
    return res.status(400).json({ ok: false, message: 'Invalid reader ID' })
  }

  if (userId === targetId) {
    return res.status(400).json({ ok: false, message: 'You cannot block yourself' })
  }

  try {
    const target = shouldBlock ? await getTarget(targetId) : null

    if (shouldBlock && !target) {
      return res.status(404).json({ ok: false, message: 'Reader not found' })
    }

    const filter = () => supabase
      .from('chat_blocks')
      .select('id')
      .eq('blocker_user_id', userId)
      .eq('blocked_user_id', targetId)
      .limit(1)
      .maybeSingle()

    const { data: existing, error: existingError } = await filter()
    if (existingError) throw existingError

    if (shouldBlock && !existing) {
      const { error } = await supabase
        .from('chat_blocks')
        .insert({ blocker_user_id: userId, blocked_user_id: targetId })

      if (error && error.code !== '23505') throw error
    }

    if (!shouldBlock && existing) {
      const { error } = await supabase
        .from('chat_blocks')
        .delete()
        .eq('blocker_user_id', userId)
        .eq('blocked_user_id', targetId)

      if (error) throw error
    }

    return res.status(200).json({
      ok: true,
      reader_id: targetId,
      is_blocked: shouldBlock,
      reader: shouldBlock ? target : null,
    })
  } catch (error) {
    console.error('READER ACCOUNT BLOCK ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to update reader block',
    })
  }
}

export function blockReaderAccount(req, res) {
  return changeReaderBlock(req, res, true)
}

export function unblockReaderAccount(req, res) {
  return changeReaderBlock(req, res, false)
}
