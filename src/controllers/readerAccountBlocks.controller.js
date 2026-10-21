import { supabase } from '../config/supabase.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PARTICIPANT_PAGE_SIZE = 500
const CONVERSATION_BATCH_SIZE = 80

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

async function getActiveConversationIds(userId) {
  const ids = new Set()

  for (let offset = 0; ; offset += PARTICIPANT_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('chat_participants')
      .select('conversation_id')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('conversation_id', { ascending: true })
      .range(offset, offset + PARTICIPANT_PAGE_SIZE - 1)

    if (error) throw error

    const rows = data || []
    for (const row of rows) {
      if (row.conversation_id) ids.add(String(row.conversation_id))
    }
    if (rows.length < PARTICIPANT_PAGE_SIZE) break
  }

  return ids
}

async function getSharedDirectConversations(userId, targetId) {
  const [mine, theirs] = await Promise.all([
    getActiveConversationIds(userId),
    getActiveConversationIds(targetId),
  ])

  const sharedIds = [...mine].filter((id) => theirs.has(id))
  const conversations = []

  for (let i = 0; i < sharedIds.length; i += CONVERSATION_BATCH_SIZE) {
    const { data, error } = await supabase
      .from('chat_conversations')
      .select('id, conversation_type, is_group, request_status, request_decided_at, status_before_block, request_decided_at_before_block')
      .in('id', sharedIds.slice(i, i + CONVERSATION_BATCH_SIZE))

    if (error) throw error

    conversations.push(...(data || []).filter((row) =>
      row.is_group !== true &&
      ['reader_reader', 'reader_author'].includes(row.conversation_type)
    ))
  }

  return conversations
}

async function syncChatConversations(userId, targetId, shouldBlock) {
  const conversations = await getSharedDirectConversations(userId, targetId)
  if (!conversations.length) return

  if (shouldBlock) {
    for (const conversation of conversations) {
      if (conversation.request_status === 'blocked') continue

      const { error } = await supabase
        .from('chat_conversations')
        .update({
          request_status: 'blocked',
          request_decided_at: new Date().toISOString(),
          status_before_block: conversation.request_status,
          request_decided_at_before_block: conversation.request_decided_at,
        })
        .eq('id', conversation.id)
        .eq('request_status', conversation.request_status)

      if (error) throw error
    }
    return
  }

  const { data: remainingBlocks, error: remainingError } = await supabase
    .from('chat_blocks')
    .select('id')
    .or(`and(blocker_user_id.eq.${userId},blocked_user_id.eq.${targetId}),and(blocker_user_id.eq.${targetId},blocked_user_id.eq.${userId})`)
    .limit(1)

  if (remainingError) throw remainingError
  if (remainingBlocks?.length) return

  for (const conversation of conversations) {
    if (conversation.request_status !== 'blocked') continue

    const previousStatus = ['pending', 'accepted', 'declined'].includes(
      conversation.status_before_block
    ) ? conversation.status_before_block : 'pending'

    const { error } = await supabase
      .from('chat_conversations')
      .update({
        request_status: previousStatus,
        request_decided_at: conversation.request_decided_at_before_block,
        status_before_block: null,
        request_decided_at_before_block: null,
      })
      .eq('id', conversation.id)
      .eq('request_status', 'blocked')

    if (error) throw error
  }
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

    await syncChatConversations(userId, targetId, shouldBlock)

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
