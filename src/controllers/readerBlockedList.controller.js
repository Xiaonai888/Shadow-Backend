import { supabase } from '../config/supabase.js'

const DEFAULT_LIMIT = 10

function toNonNegativeInteger(value, fallback) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback
}

export async function getMyReaderBlockedList(req, res) {
  const userId = String(req.user?.user_id || '').trim()
  const type = String(req.query?.type || '').trim().toLowerCase()

  if (!userId) {
    return res.status(401).json({ ok: false, message: 'Unauthorized' })
  }

  if (type !== 'reader' && type !== 'page') {
    return res.status(400).json({ ok: false, message: 'Invalid block list type' })
  }

  const limit = Math.min(DEFAULT_LIMIT, Math.max(1, toNonNegativeInteger(req.query?.limit, DEFAULT_LIMIT)))
  const offset = Math.min(10000, toNonNegativeInteger(req.query?.offset, 0))
  const reader = type === 'reader'
  const blockTable = reader ? 'chat_blocks' : 'reader_blocked_author_pages'
  const ownerColumn = reader ? 'blocker_user_id' : 'reader_user_id'
  const targetColumn = reader ? 'blocked_user_id' : 'author_page_id'

  try {
    const { data: blocks, error: blockError, count } = await supabase
      .from(blockTable)
      .select(`id, ${targetColumn}, created_at`, { count: 'exact' })
      .eq(ownerColumn, userId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1)

    if (blockError) throw blockError

    const blockRows = blocks || []
    const ids = [...new Set(blockRows.map((block) => block[targetColumn]).filter(Boolean))]
    let targets = []

    if (ids.length > 0) {
      const { data, error } = reader
        ? await supabase
            .from('users')
            .select('id, name, username, avatar_url')
            .in('id', ids)
        : await supabase
            .from('author_pages')
            .select('id, page_name, page_username, avatar_url')
            .in('id', ids)

      if (error) throw error
      targets = data || []
    }

    const targetsById = new Map(targets.map((target) => [String(target.id), target]))
    const results = blockRows.map((block) => {
      const targetId = String(block[targetColumn])
      const target = targetsById.get(targetId)

      return {
        id: targetId,
        block_id: block.id,
        target_type: type,
        name: reader ? target?.name || 'Reader' : target?.page_name || 'Page',
        username: reader ? target?.username || '' : target?.page_username || '',
        avatar_url: target?.avatar_url || null,
        blocked_at: block.created_at,
      }
    })

    const total = typeof count === 'number' ? count : offset + blockRows.length

    return res.status(200).json({
      ok: true,
      type,
      results,
      total,
      has_more: offset + blockRows.length < total,
    })
  } catch (error) {
    console.error('GET READER BLOCKED LIST ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load blocked list' })
  }
}
