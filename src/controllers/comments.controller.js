import { supabase } from '../config/supabase.js'

function normalizeText(value) {
  return String(value || '').trim()
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

function publicComment(comment) {
  return {
    id: comment.id,
    story_id: comment.story_id,
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
    liked: Boolean(comment.liked),
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

async function getComment(commentId) {
  const { data, error } = await supabase
    .from('comments')
    .select('*')
    .eq('id', commentId)
    .maybeSingle()

  if (error) throw error
  return data
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

export async function getStoryComments(req, res) {
  try {
    const storyId = String(req.params.storyId || '').trim()

    const story = await getStory(storyId)

    if (!story) {
      return res.status(404).json({
        ok: false,
        message: 'Story not found',
      })
    }

    const { data, error } = await supabase
      .from('comments')
      .select('*, user:users(id, name, username, avatar_url, role)')
      .eq('story_id', storyId)
      .eq('is_hidden', false)
      .order('is_pinned', { ascending: false })
      .order('created_at', { ascending: false })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      comments: (data || []).map(publicComment),
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

    return res.status(200).json({
      ok: true,
      comment: publicComment(data),
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

    return res.status(200).json({
      ok: true,
      comment: publicComment(data),
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
