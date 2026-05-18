import { supabase } from '../config/supabase.js'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const OWNER_REPORT_LIMIT = 50

function normalizeText(value) {
  return String(value || '').trim()
}

function normalizeLimit(value, fallback = DEFAULT_LIMIT) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(Math.floor(number), MAX_LIMIT)
}

function normalizePage(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 1
  return Math.floor(number)
}

function getActor(req) {
  return (
    req.admin?.actor ||
    req.admin?.name ||
    req.get('x-admin-actor') ||
    req.get('x-admin-name') ||
    'Admin'
  )
}

function getAdminId(req) {
  return req.admin?.admin_id || req.admin?.id || req.get('x-admin-id') || null
}

function publicUser(user) {
  if (!user) {
    return {
      id: null,
      name: 'Reader',
      username: '',
      avatar_url: '',
      role: 'reader',
    }
  }

  return {
    id: user.id,
    name: user.name || user.username || 'Reader',
    username: user.username || '',
    avatar_url: user.avatar_url || '',
    role: user.role || 'reader',
  }
}

function publicStory(story) {
  if (!story) {
    return {
      id: null,
      title: 'Unknown Story',
      cover_url: '',
      author_id: null,
    }
  }

  return {
    id: story.id,
    title: story.title || 'Untitled Story',
    cover_url: story.cover_url || '',
    author_id: story.author_id || null,
  }
}

function publicComment(comment) {
  return {
    id: comment.id,
    story_id: comment.story_id,
    user_id: comment.user_id,
    parent_id: comment.parent_id,
    text: comment.text || '',
    is_pinned: Boolean(comment.is_pinned),
    is_hidden: Boolean(comment.is_hidden),
    is_spoiler: Boolean(comment.is_spoiler),
    status: Boolean(comment.is_hidden) ? 'hidden' : 'visible',
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    user: publicUser(comment.user),
    story: publicStory(comment.story),
  }
}

function publicOwnerReport(record) {
  return {
    id: record.id,
    action: record.action,
    section_key: record.section_key,
    actor: record.actor || 'Admin',
    details: record.details || '',
    created_at: record.created_at,
  }
}

function buildActionDetails({ action, comment, actor, reason = '' }) {
  const storyTitle = comment?.story?.title || comment?.story_title || 'Unknown Story'
  const userName = comment?.user?.name || comment?.user?.username || 'Reader'
  const text = normalizeText(comment?.text).slice(0, 120)
  const reasonText = reason ? ` Reason: ${reason}` : ''

  if (action === 'hide') return `${actor} hid a comment by ${userName} on "${storyTitle}". ${text}${reasonText}`
  if (action === 'unhide') return `${actor} unhid a comment by ${userName} on "${storyTitle}". ${text}${reasonText}`
  if (action === 'delete') return `${actor} deleted a comment by ${userName} on "${storyTitle}". ${text}${reasonText}`
  if (action === 'ban') return `${actor} banned ${userName} from commenting on "${storyTitle}".${reasonText}`
  if (action === 'pin') return `${actor} pinned a comment by ${userName} on "${storyTitle}".`
  if (action === 'unpin') return `${actor} unpinned a comment by ${userName} on "${storyTitle}".`
  if (action === 'spoiler') return `${actor} marked a comment as spoiler on "${storyTitle}".`
  if (action === 'unspoiler') return `${actor} removed spoiler mark from a comment on "${storyTitle}".`

  return `${actor} updated a comment on "${storyTitle}".${reasonText}`
}

async function createOwnerReport({ req, action, comment, reason = '' }) {
  try {
    const actor = getActor(req)
    const details = buildActionDetails({ action, comment, actor, reason })

    await supabase
      .from('admin_activity_logs')
      .insert({
        action,
        section_key: 'comments',
        slide_id: comment?.id || null,
        slide_title: comment?.story?.title || 'Comment Moderation',
        order_index: null,
        actor,
        details,
      })
  } catch (error) {
    console.warn('CREATE COMMENT OWNER REPORT WARNING:', error.message)
  }
}

async function getCommentById(commentId) {
  const { data, error } = await supabase
    .from('comments')
    .select('*, user:users(id, name, username, avatar_url, role), story:stories(id, title, cover_url, author_id, total_comments)')
    .eq('id', commentId)
    .maybeSingle()

  if (error) throw error
  return data
}

async function updateStoryCommentCount(storyId, amount) {
  if (!storyId) return

  try {
    const { data: story, error: storyError } = await supabase
      .from('stories')
      .select('total_comments')
      .eq('id', storyId)
      .maybeSingle()

    if (storyError) throw storyError

    const nextCount = Math.max(0, Number(story?.total_comments || 0) + amount)

    await supabase
      .from('stories')
      .update({
        total_comments: nextCount,
        updated_at: new Date().toISOString(),
      })
      .eq('id', storyId)
  } catch (error) {
    console.warn('UPDATE STORY COMMENT COUNT WARNING:', error.message)
  }
}

function filterComments(comments, query) {
  const text = normalizeText(query).toLowerCase()
  if (!text) return comments

  return comments.filter((comment) => {
    const values = [
      comment.text,
      comment.user?.name,
      comment.user?.username,
      comment.story?.title,
    ]

    return values.some((value) => String(value || '').toLowerCase().includes(text))
  })
}

export async function getAdminComments(req, res) {
  try {
    const limit = normalizeLimit(req.query.limit)
    const page = normalizePage(req.query.page)
    const search = normalizeText(req.query.q || req.query.search)
    const status = normalizeText(req.query.status || 'all').toLowerCase()
    const storyId = normalizeText(req.query.storyId || req.query.story_id)
    const userId = normalizeText(req.query.userId || req.query.user_id)
    const fetchLimit = search ? MAX_LIMIT : limit
    const from = search ? 0 : (page - 1) * limit
    const to = search ? fetchLimit - 1 : from + limit - 1

    let query = supabase
      .from('comments')
      .select('*, user:users(id, name, username, avatar_url, role), story:stories(id, title, cover_url, author_id, total_comments)', {
        count: 'exact',
      })
      .order('created_at', { ascending: false })
      .range(from, to)

    if (status === 'hidden') query = query.eq('is_hidden', true)
    if (status === 'visible') query = query.eq('is_hidden', false)
    if (storyId) query = query.eq('story_id', storyId)
    if (userId) query = query.eq('user_id', userId)

    const { data, error, count } = await query

    if (error) throw error

    const filtered = filterComments(data || [], search)
    const comments = filtered.slice(0, limit).map(publicComment)

    return res.status(200).json({
      ok: true,
      page,
      limit,
      total: search ? filtered.length : count || comments.length,
      comments,
    })
  } catch (error) {
    console.error('GET ADMIN COMMENTS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load admin comments',
      error: error.message,
    })
  }
}

export async function moderateAdminComment(req, res) {
  try {
    const commentId = normalizeText(req.params.commentId)
    const action = normalizeText(req.body.action).toLowerCase()
    const reason = normalizeText(req.body.reason)

    if (!commentId) {
      return res.status(400).json({
        ok: false,
        message: 'Comment id is required',
      })
    }

    const oldComment = await getCommentById(commentId)

    if (!oldComment) {
      return res.status(404).json({
        ok: false,
        message: 'Comment not found',
      })
    }

    if (action === 'delete') {
      const { error } = await supabase
        .from('comments')
        .delete()
        .eq('id', commentId)

      if (error) throw error

      await updateStoryCommentCount(oldComment.story_id, -1)
      await createOwnerReport({ req, action, comment: oldComment, reason })

      return res.status(200).json({
        ok: true,
        message: 'Comment deleted',
      })
    }

    if (action === 'ban') {
      const { error } = await supabase
        .from('comment_bans')
        .upsert({
          story_id: oldComment.story_id,
          user_id: oldComment.user_id,
          banned_by_user_id: getAdminId(req),
          reason,
        }, {
          onConflict: 'story_id,user_id',
        })

      if (error) throw error

      await createOwnerReport({ req, action, comment: oldComment, reason })

      return res.status(200).json({
        ok: true,
        message: 'User banned from commenting',
      })
    }

    const updateData = {
      updated_at: new Date().toISOString(),
    }

    if (action === 'hide') updateData.is_hidden = true
    if (action === 'unhide') updateData.is_hidden = false
    if (action === 'pin') updateData.is_pinned = true
    if (action === 'unpin') updateData.is_pinned = false
    if (action === 'spoiler') updateData.is_spoiler = true
    if (action === 'unspoiler') updateData.is_spoiler = false

    if (Object.keys(updateData).length <= 1) {
      return res.status(400).json({
        ok: false,
        message: 'Action is not valid',
      })
    }

    const { data, error } = await supabase
      .from('comments')
      .update(updateData)
      .eq('id', commentId)
      .select('*, user:users(id, name, username, avatar_url, role), story:stories(id, title, cover_url, author_id, total_comments)')
      .single()

    if (error) throw error

    await createOwnerReport({ req, action, comment: data, reason })

    return res.status(200).json({
      ok: true,
      comment: publicComment(data),
    })
  } catch (error) {
    console.error('MODERATE ADMIN COMMENT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to moderate comment',
      error: error.message,
    })
  }
}

export async function deleteAdminComment(req, res) {
  req.body.action = 'delete'
  return moderateAdminComment(req, res)
}

export async function banAdminCommentUser(req, res) {
  req.body.action = 'ban'
  return moderateAdminComment(req, res)
}

export async function getAdminCommentOwnerReports(req, res) {
  try {
    const limit = normalizeLimit(req.query.limit, OWNER_REPORT_LIMIT)

    const { data, error } = await supabase
      .from('admin_activity_logs')
      .select('*')
      .eq('section_key', 'comments')
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      records: (data || []).map(publicOwnerReport),
    })
  } catch (error) {
    console.error('GET COMMENT OWNER REPORTS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load owner reports',
      error: error.message,
    })
  }
}
