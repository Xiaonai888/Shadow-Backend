import jwt from 'jsonwebtoken'
import { supabase } from '../config/supabase.js'
import { getActiveReaderCommentBlock, readerCommentBlockedPayload } from '../utils/readerCommentBlocks.js'

function normalizeText(value) {
  return String(value || '').trim()
}

function getRequestUserId(req) {
  try {
    const authHeader = req.headers.authorization || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

    if (!token) return null

    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    if (decoded.type !== 'reader') return null

    return decoded.user_id || null
  } catch {
    return null
  }
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

function publicComment(comment, likedIds = new Set()) {
  return {
    id: comment.id,
    story_id: comment.story_id,
    episode_id: comment.episode_id || null,
    user_id: comment.user_id,
    parent_id: comment.parent_id,
    text: comment.text,
    is_pinned: Boolean(comment.is_pinned),
    is_hidden: Boolean(comment.is_hidden),
    is_spoiler: Boolean(comment.is_spoiler),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    user: publicUser(comment.user),
    likes: Number(comment.likes || 0),
    liked: likedIds.has(String(comment.id)),
  }
}

async function getStory(storyId) {
  const { data, error } = await supabase
    .from('stories')
    .select('id, user_id, author_id, status, total_comments')
    .eq('id', storyId)
    .maybeSingle()

  if (error) throw error

  return data
}

async function getEpisode(episodeId) {
  const { data, error } = await supabase
    .from('episodes')
    .select('id, story_id')
    .eq('id', episodeId)
    .maybeSingle()

  if (error) throw error

  return data
}

async function getComment(commentId) {
  const { data, error } = await supabase
    .from('comments')
    .select('*')
    .eq('id', commentId)
    .maybeSingle()

  if (error) throw error

  return data
}

async function getPublicComment(commentId, userId = null) {
  const { data, error } = await supabase
    .from('comments')
    .select('*, user:users(id, name, username, avatar_url, role)')
    .eq('id', commentId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const likedIds = new Set()

  if (userId) {
    const { data: like } = await supabase
      .from('comment_likes')
      .select('comment_id')
      .eq('comment_id', commentId)
      .eq('user_id', userId)
      .maybeSingle()

    if (like?.comment_id) likedIds.add(String(like.comment_id))
  }

  return publicComment(data, likedIds)
}

async function getUser(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('id, name, username, avatar_url, role, is_author')
    .eq('id', userId)
    .maybeSingle()

  if (error) throw error

  return data
}

async function isBannedFromStory(storyId, userId) {
  const { data, error } = await supabase
    .from('comment_bans')
    .select('id')
    .eq('story_id', storyId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error

  return Boolean(data)
}

async function canModerateStory(storyId, userId) {
  const [story, user] = await Promise.all([getStory(storyId), getUser(userId)])

  if (!story || !user) {
    return {
      ok: false,
      story,
      user,
      isAdmin: false,
      isAuthor: false,
    }
  }

  const isAdmin = user.role === 'admin' || user.role === 'super_admin'
  const isAuthor = String(story.user_id || '') === String(userId)

  return {
    ok: isAdmin || isAuthor,
    story,
    user,
    isAdmin,
    isAuthor,
  }
}

async function getLikedIds(commentIds, userId) {
  if (!userId || !commentIds.length) return new Set()

  const { data, error } = await supabase
    .from('comment_likes')
    .select('comment_id')
    .eq('user_id', userId)
    .in('comment_id', commentIds)

  if (error) throw error

  return new Set((data || []).map((item) => String(item.comment_id)))
}

function attachReplies(parentComments, replies) {
  const replyMap = new Map()

  replies.forEach((reply) => {
    const key = String(reply.parent_id || '')
    const current = replyMap.get(key) || []
    current.push(reply)
    replyMap.set(key, current)
  })

  return parentComments.map((comment) => ({
    ...comment,
    replies: replyMap.get(String(comment.id)) || [],
  }))
}

export async function getStoryComments(req, res) {
  try {
    const storyId = String(req.params.storyId || '').trim()
    const page = Math.max(1, Number(req.query.page || 1))
    const limit = Math.min(30, Math.max(5, Number(req.query.limit || 20)))
    const sort = String(req.query.sort || 'newest').trim().toLowerCase()
    const from = (page - 1) * limit
    const to = from + limit - 1
    const userId = getRequestUserId(req)

    const story = await getStory(storyId)

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    let query = supabase
      .from('comments')
      .select('*, user:users(id, name, username, avatar_url, role)', { count: 'exact' })
      .eq('story_id', storyId)
      .eq('is_hidden', false)
      .is('parent_id', null)
      .range(from, to)

    if (sort === 'top') {
      query = query
        .order('is_pinned', { ascending: false })
        .order('likes', { ascending: false })
        .order('created_at', { ascending: false })
    } else if (sort === 'oldest') {
      query = query
        .order('is_pinned', { ascending: false })
        .order('created_at', { ascending: true })
    } else {
      query = query
        .order('is_pinned', { ascending: false })
        .order('created_at', { ascending: false })
    }

    const { data, error, count } = await query

    if (error) throw error

    const parentIds = (data || []).map((comment) => comment.id)
    let replies = []

    if (parentIds.length) {
      const { data: replyData, error: replyError } = await supabase
        .from('comments')
        .select('*, user:users(id, name, username, avatar_url, role)')
        .eq('story_id', storyId)
        .eq('is_hidden', false)
        .in('parent_id', parentIds)
        .order('created_at', { ascending: true })

      if (replyError) throw replyError

      replies = replyData || []
    }

    const allIds = [...parentIds, ...replies.map((reply) => reply.id)]
    const likedIds = await getLikedIds(allIds, userId)
    const publicParents = (data || []).map((comment) => publicComment(comment, likedIds))
    const publicReplies = replies.map((reply) => publicComment(reply, likedIds))
    const comments = attachReplies(publicParents, publicReplies)
    const total = Number(count || 0)

    return res.status(200).json({
      ok: true,
      comments,
      page,
      limit,
      total,
      has_more: page * limit < total,
    })
  } catch (error) {
    console.error('GET STORY COMMENTS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load comments',
      error: error.message,
    })
  }
}

export async function getEpisodeComments(req, res) {
  try {
    const episodeId = String(req.params.episodeId || '').trim()
    const page = Math.max(1, Number(req.query.page || 1))
    const limit = Math.min(30, Math.max(5, Number(req.query.limit || 20)))
    const sort = String(req.query.sort || 'newest').trim().toLowerCase()
    const from = (page - 1) * limit
    const to = from + limit - 1
    const userId = getRequestUserId(req)

    const episode = await getEpisode(episodeId)

    if (!episode) {
      return res.status(404).json({
        ok: false,
        message: 'Episode not found',
      })
    }

    let query = supabase
      .from('comments')
      .select('*, user:users(id, name, username, avatar_url, role)', { count: 'exact' })
      .eq('story_id', episode.story_id)
      .eq('episode_id', episodeId)
      .eq('is_hidden', false)
      .is('parent_id', null)
      .range(from, to)

    if (sort === 'top') {
      query = query
        .order('is_pinned', { ascending: false })
        .order('likes', { ascending: false })
        .order('created_at', { ascending: false })
    } else if (sort === 'oldest') {
      query = query
        .order('is_pinned', { ascending: false })
        .order('created_at', { ascending: true })
    } else {
      query = query
        .order('is_pinned', { ascending: false })
        .order('created_at', { ascending: false })
    }

    const { data, error, count } = await query

    if (error) throw error

    const parentIds = (data || []).map((comment) => comment.id)
    let replies = []

    if (parentIds.length) {
      const { data: replyData, error: replyError } = await supabase
        .from('comments')
        .select('*, user:users(id, name, username, avatar_url, role)')
        .eq('story_id', episode.story_id)
        .eq('episode_id', episodeId)
        .eq('is_hidden', false)
        .in('parent_id', parentIds)
        .order('created_at', { ascending: true })

      if (replyError) throw replyError

      replies = replyData || []
    }

    const allIds = [...parentIds, ...replies.map((reply) => reply.id)]
    const likedIds = await getLikedIds(allIds, userId)
    const publicParents = (data || []).map((comment) => publicComment(comment, likedIds))
    const publicReplies = replies.map((reply) => publicComment(reply, likedIds))
    const comments = attachReplies(publicParents, publicReplies)
    const total = Number(count || 0)

    return res.status(200).json({
      ok: true,
      comments,
      page,
      limit,
      total,
      has_more: page * limit < total,
    })
  } catch (error) {
    console.error('GET EPISODE COMMENTS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load episode comments',
      error: error.message,
    })
  }
}

export async function createStoryComment(req, res) {
  try {
    const storyId = String(req.params.storyId || '').trim()
    const userId = req.user?.user_id
    const text = normalizeText(req.body.text)
    const parentId = String(req.body.parent_id || req.body.parentId || '').trim() || null

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const readerCommentBlock = await getActiveReaderCommentBlock(userId)

    if (readerCommentBlock) {
      return res.status(403).json(readerCommentBlockedPayload(readerCommentBlock))
    }

    if (!text) {
      return res.status(400).json({
        ok: false,
        message: 'Comment text is required',
      })
    }

    const story = await getStory(storyId)

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    const banned = await isBannedFromStory(storyId, userId)

    if (banned) {
      return res.status(403).json({
        ok: false,
        message: 'You cannot comment on this story',
      })
    }

    if (parentId) {
      const parent = await getComment(parentId)

      if (!parent || String(parent.story_id) !== String(storyId)) {
        return res.status(400).json({
          ok: false,
          message: 'Parent comment is not valid',
        })
      }
    }

    const { data, error } = await supabase
      .from('comments')
      .insert({
        story_id: storyId,
        user_id: userId,
        parent_id: parentId,
        text,
      })
      .select('*, user:users(id, name, username, avatar_url, role)')
      .single()

    if (error) throw error

    await supabase
      .from('stories')
      .update({
        total_comments: Number(story.total_comments || 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', storyId)

    return res.status(201).json({
      ok: true,
      comment: publicComment(data),
    })
  } catch (error) {
    console.error('CREATE STORY COMMENT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to create comment',
      error: error.message,
    })
  }
}

export async function createEpisodeComment(req, res) {
  try {
    const episodeId = String(req.params.episodeId || '').trim()
    const userId = req.user?.user_id
    const text = normalizeText(req.body.text)
    const parentId = String(req.body.parent_id || req.body.parentId || '').trim() || null

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const readerCommentBlock = await getActiveReaderCommentBlock(userId)

    if (readerCommentBlock) {
      return res.status(403).json(readerCommentBlockedPayload(readerCommentBlock))
    }

    if (!text) {
      return res.status(400).json({
        ok: false,
        message: 'Comment text is required',
      })
    }

    const episode = await getEpisode(episodeId)

    if (!episode) {
      return res.status(404).json({
        ok: false,
        message: 'Episode not found',
      })
    }

    const story = await getStory(episode.story_id)

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    const banned = await isBannedFromStory(episode.story_id, userId)

    if (banned) {
      return res.status(403).json({
        ok: false,
        message: 'You cannot comment on this story',
      })
    }

    if (parentId) {
      const parent = await getComment(parentId)

      if (
        !parent ||
        String(parent.story_id) !== String(episode.story_id) ||
        String(parent.episode_id || '') !== String(episodeId)
      ) {
        return res.status(400).json({
          ok: false,
          message: 'Parent comment is not valid',
        })
      }
    }

    const { data, error } = await supabase
      .from('comments')
      .insert({
        story_id: episode.story_id,
        episode_id: episodeId,
        user_id: userId,
        parent_id: parentId,
        text,
      })
      .select('*, user:users(id, name, username, avatar_url, role)')
      .single()

    if (error) throw error

    await supabase
      .from('stories')
      .update({
        total_comments: Number(story.total_comments || 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', episode.story_id)

    return res.status(201).json({
      ok: true,
      comment: publicComment(data),
    })
  } catch (error) {
    console.error('CREATE EPISODE COMMENT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to create episode comment',
      error: error.message,
    })
  }
}

export async function toggleCommentLike(req, res) {
  try {
    const commentId = String(req.params.commentId || '').trim()
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const comment = await getComment(commentId)

    if (!comment || comment.is_hidden) {
      return res.status(404).json({
        ok: false,
        message: 'Comment not found',
      })
    }

    const { data: existingLike, error: likeLookupError } = await supabase
      .from('comment_likes')
      .select('id')
      .eq('comment_id', commentId)
      .eq('user_id', userId)
      .maybeSingle()

    if (likeLookupError) throw likeLookupError

    let liked = false

    if (existingLike?.id) {
      const { error } = await supabase
        .from('comment_likes')
        .delete()
        .eq('id', existingLike.id)

      if (error) throw error
    } else {
      const { error } = await supabase
        .from('comment_likes')
        .insert({
          comment_id: commentId,
          user_id: userId,
        })

      if (error) throw error

      liked = true
    }

    const { count, error: countError } = await supabase
      .from('comment_likes')
      .select('id', { count: 'exact', head: true })
      .eq('comment_id', commentId)

    if (countError) throw countError

    const likes = Number(count || 0)

    const { error: updateError } = await supabase
      .from('comments')
      .update({
        likes,
        updated_at: new Date().toISOString(),
      })
      .eq('id', commentId)

    if (updateError) throw updateError

    return res.status(200).json({
      ok: true,
      comment_id: commentId,
      liked,
      likes,
    })
  } catch (error) {
    console.error('TOGGLE COMMENT LIKE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to update like',
      error: error.message,
    })
  }
}

export async function updateOwnComment(req, res) {
  try {
    const commentId = String(req.params.commentId || '').trim()
    const userId = req.user?.user_id
    const text = normalizeText(req.body.text)

    if (!text) {
      return res.status(400).json({
        ok: false,
        message: 'Comment text is required',
      })
    }

    const comment = await getComment(commentId)

    if (!comment) {
      return res.status(404).json({
        ok: false,
        message: 'Comment not found',
      })
    }

    if (String(comment.user_id) !== String(userId)) {
      return res.status(403).json({
        ok: false,
        message: 'You can only edit your own comment',
      })
    }

    const { data, error } = await supabase
      .from('comments')
      .update({
        text,
        updated_at: new Date().toISOString(),
      })
      .eq('id', commentId)
      .select('*, user:users(id, name, username, avatar_url, role)')
      .single()

    if (error) throw error

    const updatedComment = await getPublicComment(data.id, userId)

    return res.status(200).json({
      ok: true,
      comment: updatedComment || publicComment(data),
    })
  } catch (error) {
    console.error('UPDATE OWN COMMENT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to update comment',
      error: error.message,
    })
  }
}

export async function moderateComment(req, res) {
  try {
    const commentId = String(req.params.commentId || '').trim()
    const userId = req.user?.user_id
    const action = String(req.body.action || '').trim()

    const comment = await getComment(commentId)

    if (!comment) {
      return res.status(404).json({
        ok: false,
        message: 'Comment not found',
      })
    }

    const permission = await canModerateStory(comment.story_id, userId)

    if (!permission.ok) {
      return res.status(403).json({
        ok: false,
        message: 'You cannot moderate this comment',
      })
    }

    if (action === 'delete') {
      if (!permission.isAdmin) {
        return res.status(403).json({
          ok: false,
          message: 'Only admin can delete comments',
        })
      }

      const { error } = await supabase
        .from('comments')
        .delete()
        .eq('id', commentId)

      if (error) throw error

      return res.status(200).json({
        ok: true,
        message: 'Comment deleted',
      })
    }

    if (action === 'ban') {
      const { error } = await supabase
        .from('comment_bans')
        .upsert({
          story_id: comment.story_id,
          user_id: comment.user_id,
          banned_by_user_id: userId,
          reason: normalizeText(req.body.reason),
        }, {
          onConflict: 'story_id,user_id',
        })

      if (error) throw error

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
      .select('*, user:users(id, name, username, avatar_url, role)')
      .single()

    if (error) throw error

    const updatedComment = await getPublicComment(data.id, userId)

    return res.status(200).json({
      ok: true,
      comment: updatedComment || publicComment(data),
    })
  } catch (error) {
    console.error('MODERATE COMMENT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to moderate comment',
      error: error.message,
    })
  }
}

async function fetchStoryMap(storyIds) {
  const ids = [...new Set((storyIds || []).filter(Boolean))]

  if (!ids.length) return new Map()

  const { data, error } = await supabase
    .from('stories')
    .select('id, title, cover_url')
    .in('id', ids)

  if (error) throw error

  return new Map((data || []).map((story) => [story.id, story]))
}

function publicMyCommentActivity(comment, storyMap, type) {
  const story = storyMap.get(comment.story_id) || null

  return {
    id: comment.id,
    activity_type: type,
    story_id: comment.story_id,
    parent_id: comment.parent_id,
    text: comment.text,
    message: comment.text,
    link: `/story/${comment.story_id}`,
    is_hidden: Boolean(comment.is_hidden),
    is_read: true,
    notification_id: null,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    story,
  }
}

export async function getMyCommentActivities(req, res) {
  try {
    const userId = req.user?.user_id
    const filter = String(req.query.filter || 'mine').trim().toLowerCase()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, username, name')
      .eq('id', userId)
      .maybeSingle()

    if (userError) throw userError

    let activities = []

    if (filter === 'replies') {
      const { data: parents, error: parentError } = await supabase
        .from('comments')
        .select('id')
        .eq('user_id', userId)
        .eq('is_hidden', false)
        .limit(300)

      if (parentError) throw parentError

      const parentIds = (parents || []).map((item) => item.id)

      if (parentIds.length) {
        const { data, error } = await supabase
          .from('comments')
          .select('id, story_id, user_id, parent_id, text, is_hidden, created_at, updated_at')
          .in('parent_id', parentIds)
          .neq('user_id', userId)
          .eq('is_hidden', false)
          .order('created_at', { ascending: false })
          .limit(80)

        if (error) throw error

        activities = data || []
      }
    } else if (filter === 'mentions') {
      const username = String(user?.username || '').trim()

      if (username) {
        const { data, error } = await supabase
          .from('comments')
          .select('id, story_id, user_id, parent_id, text, is_hidden, created_at, updated_at')
          .ilike('text', `%@${username}%`)
          .neq('user_id', userId)
          .eq('is_hidden', false)
          .order('created_at', { ascending: false })
          .limit(80)

        if (error) throw error

        activities = data || []
      }
    } else if (filter === 'all') {
      const { data: mine, error: mineError } = await supabase
        .from('comments')
        .select('id, story_id, user_id, parent_id, text, is_hidden, created_at, updated_at')
        .eq('user_id', userId)
        .eq('is_hidden', false)
        .order('created_at', { ascending: false })
        .limit(80)

      if (mineError) throw mineError

      activities = mine || []
    } else {
      const { data, error } = await supabase
        .from('comments')
        .select('id, story_id, user_id, parent_id, text, is_hidden, created_at, updated_at')
        .eq('user_id', userId)
        .eq('is_hidden', false)
        .order('created_at', { ascending: false })
        .limit(80)

      if (error) throw error

      activities = data || []
    }

    const storyMap = await fetchStoryMap(activities.map((item) => item.story_id))

    return res.status(200).json({
      ok: true,
      filter,
      activities: activities.map((item) => publicMyCommentActivity(item, storyMap, filter === 'mine' ? 'mine' : filter.slice(0, -1))),
      counts: {
        all: filter === 'all' ? activities.length : 0,
        mine: filter === 'mine' ? activities.length : 0,
        replies: filter === 'replies' ? activities.length : 0,
        mentions: filter === 'mentions' ? activities.length : 0,
      },
    })
  } catch (error) {
    console.error('GET MY COMMENT ACTIVITIES ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load comment activity',
      error: error.message,
    })
  }
}
