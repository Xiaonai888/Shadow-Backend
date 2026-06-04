import { supabase } from '../config/supabase.js'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const REASONS = ['Spam', 'Harassment', 'Scam', 'Adult content', 'Hate speech', 'Payment abuse', 'Other']
const DURATIONS = ['1d', '3d', '7d', '30d', 'permanent']

function cleanText(value) {
  return String(value || '').trim()
}

function normalizePage(value) {
  const page = Number(value)
  if (!Number.isFinite(page) || page < 1) return 1
  return Math.floor(page)
}

function normalizeLimit(value) {
  const limit = Number(value)
  if (!Number.isFinite(limit) || limit < 1) return DEFAULT_LIMIT
  return Math.min(Math.floor(limit), MAX_LIMIT)
}

function adminActor(req) {
  return cleanText(req.admin?.email || req.admin?.username || req.admin?.admin_name || req.headers['x-admin-name'] || req.headers['x-admin-actor'] || 'Admin')
}

function cleanSearch(value) {
  return cleanText(value).replace(/[%_,()]/g, ' ')
}

function durationToExpiresAt(duration) {
  if (duration === 'permanent') return null

  const days = {
    '1d': 1,
    '3d': 3,
    '7d': 7,
    '30d': 30,
  }[duration]

  if (!days) return null

  const date = new Date()
  date.setDate(date.getDate() + days)
  return date.toISOString()
}

function publicReader(user) {
  return {
    id: user.id,
    name: user.name || user.username || 'Reader',
    username: user.username || '',
    email: user.email || '',
    avatar_url: user.avatar_url || '',
    joined_at: user.created_at,
  }
}

function publicBlock(row) {
  const user = row.user || {}

  return {
    id: row.id,
    user_id: row.user_id,
    reason: row.reason || 'Other',
    note: row.note || '',
    blocked_by: row.blocked_by || 'Admin',
    is_active: Boolean(row.is_active),
    expires_at: row.expires_at,
    is_permanent: !row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    reader: {
      id: row.user_id,
      name: user.name || user.username || 'Reader',
      username: user.username || '',
      email: user.email || '',
      avatar_url: user.avatar_url || '',
    },
  }
}

function publicRecord(row) {
  return {
    id: row.id,
    action: row.action,
    user_id: row.user_id,
    reader_name: row.reader_name || '',
    reader_email: row.reader_email || '',
    reason: row.reason || '',
    note: row.note || '',
    actor: row.actor || 'Admin',
    details: row.details || '',
    expires_at: row.expires_at,
    created_at: row.created_at,
  }
}

async function getUser(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('id, name, username, email, avatar_url, created_at')
    .eq('id', userId)
    .maybeSingle()

  if (error) throw error
  return data
}

async function createReaderBlockRecord({ action, user, reason = '', note = '', actor = 'Admin', details = '', expiresAt = null }) {
  const { error } = await supabase
    .from('reader_comment_block_logs')
    .insert({
      action,
      user_id: user.id,
      reader_name: user.name || user.username || 'Reader',
      reader_email: user.email || '',
      reason,
      note,
      actor,
      details,
      expires_at: expiresAt,
    })

  if (error) console.error('CREATE READER COMMENT BLOCK RECORD ERROR:', error)
}

export async function searchReadersForBlock(req, res) {
  try {
    const q = cleanSearch(req.query.q)
    const limit = normalizeLimit(req.query.limit || 10)

    if (!q || q.length < 2) {
      return res.status(200).json({
        ok: true,
        readers: [],
      })
    }

    const { data, error } = await supabase
      .from('users')
      .select('id, name, username, email, avatar_url, created_at')
      .or(`name.ilike.%${q}%,username.ilike.%${q}%,email.ilike.%${q}%`)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      readers: (data || []).map(publicReader),
    })
  } catch (error) {
    console.error('SEARCH READERS FOR BLOCK ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to search readers', error: error.message })
  }
}

export async function getReaderCommentBlocks(req, res) {
  try {
    const page = normalizePage(req.query.page)
    const limit = normalizeLimit(req.query.limit || 20)
    const status = cleanText(req.query.status || 'active').toLowerCase()
    const from = (page - 1) * limit
    const to = from + limit - 1

    let query = supabase
      .from('reader_comment_blocks')
      .select('*, user:users(id, name, username, email, avatar_url)', { count: 'exact' })

    if (status === 'active') query = query.eq('is_active', true)
    if (status === 'removed') query = query.eq('is_active', false)

    const { data, count, error } = await query
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) throw error

    const total = count || 0
    const totalPages = Math.max(1, Math.ceil(total / limit))

    return res.status(200).json({
      ok: true,
      blocks: (data || []).map(publicBlock),
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
    })
  } catch (error) {
    console.error('GET READER COMMENT BLOCKS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load reader comment blocks', error: error.message })
  }
}

export async function createReaderCommentBlock(req, res) {
  try {
    const userId = cleanText(req.body.user_id || req.body.userId)
    const reason = cleanText(req.body.reason || 'Other')
    const note = cleanText(req.body.note)
    const duration = cleanText(req.body.duration || '7d')
    const actor = adminActor(req)

    if (!userId) {
      return res.status(400).json({ ok: false, message: 'Reader is required' })
    }

    if (!REASONS.includes(reason)) {
      return res.status(400).json({ ok: false, message: 'Invalid block reason' })
    }

    if (!DURATIONS.includes(duration)) {
      return res.status(400).json({ ok: false, message: 'Invalid block duration' })
    }

    const user = await getUser(userId)

    if (!user) {
      return res.status(404).json({ ok: false, message: 'Reader not found' })
    }

    await supabase
      .from('reader_comment_blocks')
      .update({
        is_active: false,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('is_active', true)

    const expiresAt = durationToExpiresAt(duration)

    const { data, error } = await supabase
      .from('reader_comment_blocks')
      .insert({
        user_id: userId,
        reason,
        note,
        blocked_by: actor,
        expires_at: expiresAt,
        is_active: true,
      })
      .select('*, user:users(id, name, username, email, avatar_url)')
      .single()

    if (error) throw error

    await createReaderBlockRecord({
      action: 'BLOCK',
      user,
      reason,
      note,
      actor,
      expiresAt,
      details: expiresAt
        ? `Blocked reader comments until ${new Date(expiresAt).toLocaleString()}`
        : 'Blocked reader comments permanently',
    })

    return res.status(201).json({
      ok: true,
      block: publicBlock(data),
    })
  } catch (error) {
    console.error('CREATE READER COMMENT BLOCK ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to block reader comments', error: error.message })
  }
}

export async function unblockReaderComment(req, res) {
  try {
    const { blockId } = req.params
    const actor = adminActor(req)

    const { data: block, error: blockError } = await supabase
      .from('reader_comment_blocks')
      .select('*, user:users(id, name, username, email, avatar_url)')
      .eq('id', blockId)
      .maybeSingle()

    if (blockError) throw blockError
    if (!block) return res.status(404).json({ ok: false, message: 'Reader block not found' })

    const { data: updatedBlock, error } = await supabase
      .from('reader_comment_blocks')
      .update({
        is_active: false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', blockId)
      .select('*, user:users(id, name, username, email, avatar_url)')
      .single()

    if (error) throw error

    const user = block.user || { id: block.user_id, name: '', username: '', email: '' }

    await createReaderBlockRecord({
      action: 'UNBLOCK',
      user: { id: block.user_id, name: user.name, username: user.username, email: user.email },
      reason: block.reason,
      note: block.note,
      actor,
      expiresAt: block.expires_at,
      details: 'Unblocked reader comments',
    })

    return res.status(200).json({
      ok: true,
      block: publicBlock(updatedBlock),
    })
  } catch (error) {
    console.error('UNBLOCK READER COMMENT ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to unblock reader comments', error: error.message })
  }
}

export async function getReaderCommentBlockRecords(req, res) {
  try {
    const page = normalizePage(req.query.page)
    const limit = normalizeLimit(req.query.limit || 20)
    const from = (page - 1) * limit
    const to = from + limit - 1

    const { data, count, error } = await supabase
      .from('reader_comment_block_logs')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) throw error

    const total = count || 0
    const totalPages = Math.max(1, Math.ceil(total / limit))

    return res.status(200).json({
      ok: true,
      records: (data || []).map(publicRecord),
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
    })
  } catch (error) {
    console.error('GET READER COMMENT BLOCK RECORDS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load reader block records', error: error.message })
  }
}
