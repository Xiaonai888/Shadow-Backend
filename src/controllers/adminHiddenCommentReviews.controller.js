import { supabase } from '../config/supabase.js'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

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
    .select('id, name, username, email, avatar_url')
    .eq('id', userId)
    .maybeSingle()

  if (error) throw error
  return data
}

async function createReaderRecord({ action, userId, reason = '', note = '', actor = 'Admin', details = '', expiresAt = null }) {
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

async function getUserMap(userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean).map(String))]
  const map = new Map()

  if (!ids.length) return map

  const { data, error } = await supabase
    .from('users')
    .select('id, name, username, email, avatar_url')
    .in('id', ids)

  if (error) throw error

  ;(data || []).forEach((user) => {
    map.set(String(user.id), user)
  })

  return map
}

async function getStoryMap(storyIds) {
  const ids = [...new Set((storyIds || []).filter(Boolean).map(String))]
  const map = new Map()

  if (!ids.length) return map

  const { data, error } = await supabase
    .from('stories')
    .select('id, title, cover_url')
    .in('id', ids)

  if (error) throw error

  ;(data || []).forEach((story) => {
    map.set(String(story.id), story)
  })

  return map
}

function publicHiddenComment(row, userMap, storyMap) {
  const user = userMap.get(String(row.user_id)) || {}
  const story = storyMap.get(String(row.story_id)) || {}

  return {
    id: row.id,
    comment_id: row.comment_id,
    story_id: row.story_id,
    user_id: row.user_id,
    matched_words: Array.isArray(row.matched_words) ? row.matched_words : [],
    comment_text: row.comment_text || '',
    status: row.status || 'hidden',
    source: row.source || 'auto_block_words',
    created_at: row.created_at,
    reviewed_at: row.reviewed_at,
    reviewed_by: row.reviewed_by || '',
    admin_note: row.admin_note || '',
    reader: {
      id: row.user_id,
      name: user.name || user.username || 'Reader',
      username: user.username || '',
      email: user.email || '',
      avatar_url: user.avatar_url || '',
    },
    story: {
      id: row.story_id,
      title: story.title || 'Story',
      cover_url: story.cover_url || '',
    },
  }
}

export async function getHiddenCommentReviews(req, res) {
  try {
    const page = normalizePage(req.query.page)
    const limit = normalizeLimit(req.query.limit || 20)
    const status = cleanText(req.query.status || 'hidden').toLowerCase()
    const from = (page - 1) * limit
    const to = from + limit - 1

    let query = supabase
      .from('reader_comment_auto_hide_logs')
      .select('*', { count: 'exact' })

    if (status !== 'all') query = query.eq('status', status)

    const { data, count, error } = await query
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) throw error

    const rows = data || []
    const [userMap, storyMap] = await Promise.all([
      getUserMap(rows.map((item) => item.user_id)),
      getStoryMap(rows.map((item) => item.story_id)),
    ])

    const total = count || 0
    const totalPages = Math.max(1, Math.ceil(total / limit))

    return res.status(200).json({
      ok: true,
      reviews: rows.map((row) => publicHiddenComment(row, userMap, storyMap)),
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
    })
  } catch (error) {
    console.error('GET HIDDEN COMMENT REVIEWS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load hidden comment reviews', error: error.message })
  }
}

export async function restoreHiddenComment(req, res) {
  try {
    const { reviewId } = req.params
    const actor = adminActor(req)
    const adminNote = cleanText(req.body.admin_note)

    const { data: review, error: reviewError } = await supabase
      .from('reader_comment_auto_hide_logs')
      .select('*')
      .eq('id', reviewId)
      .maybeSingle()

    if (reviewError) throw reviewError
    if (!review) return res.status(404).json({ ok: false, message: 'Hidden comment review not found' })

    if (review.comment_id) {
      const { error: commentError } = await supabase
        .from('comments')
        .update({
          is_hidden: false,
          updated_at: new Date().toISOString(),
        })
        .eq('id', review.comment_id)

      if (commentError) throw commentError
    }

    const { data, error } = await supabase
      .from('reader_comment_auto_hide_logs')
      .update({
        status: 'restored',
        reviewed_at: new Date().toISOString(),
        reviewed_by: actor,
        admin_note: adminNote,
      })
      .eq('id', reviewId)
      .select('*')
      .single()

    if (error) throw error

    await createReaderRecord({
      action: 'RESTORE_COMMENT',
      userId: review.user_id,
      reason: 'Admin review',
      note: adminNote,
      actor,
      details: `Restored auto hidden comment. Matched: ${matchedWordsText(review.matched_words)}`,
    })

    return res.status(200).json({
      ok: true,
      review: data,
      message: 'Comment restored',
    })
  } catch (error) {
    console.error('RESTORE HIDDEN COMMENT ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to restore hidden comment', error: error.message })
  }
}

export async function keepHiddenComment(req, res) {
  try {
    const { reviewId } = req.params
    const actor = adminActor(req)
    const adminNote = cleanText(req.body.admin_note)

    const { data: review, error: reviewError } = await supabase
      .from('reader_comment_auto_hide_logs')
      .select('*')
      .eq('id', reviewId)
      .maybeSingle()

    if (reviewError) throw reviewError
    if (!review) return res.status(404).json({ ok: false, message: 'Hidden comment review not found' })

    if (review.comment_id) {
      const { error: commentError } = await supabase
        .from('comments')
        .update({
          is_hidden: true,
          updated_at: new Date().toISOString(),
        })
        .eq('id', review.comment_id)

      if (commentError) throw commentError
    }

    const { data, error } = await supabase
      .from('reader_comment_auto_hide_logs')
      .update({
        status: 'kept_hidden',
        reviewed_at: new Date().toISOString(),
        reviewed_by: actor,
        admin_note: adminNote,
      })
      .eq('id', reviewId)
      .select('*')
      .single()

    if (error) throw error

    await createReaderRecord({
      action: 'KEEP_HIDDEN',
      userId: review.user_id,
      reason: 'Admin review',
      note: adminNote,
      actor,
      details: `Kept auto hidden comment hidden. Matched: ${matchedWordsText(review.matched_words)}`,
    })

    return res.status(200).json({
      ok: true,
      review: data,
      message: 'Comment kept hidden',
    })
  } catch (error) {
    console.error('KEEP HIDDEN COMMENT ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to keep hidden comment', error: error.message })
  }
}
