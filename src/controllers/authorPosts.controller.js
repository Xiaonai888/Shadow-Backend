import { supabase } from '../config/supabase.js'

function normalizePageUsername(username) {
  return String(username || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase()
}

function normalizeImageUrls(value) {
  if (!Array.isArray(value)) return []

  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 5)
}

function publicAuthorPost(post) {
  if (!post) return null

  return {
    id: post.id,
    author_page_id: post.author_page_id,
    user_id: post.user_id,
    post_type: post.post_type || 'article',
    content: post.content || '',
    image_urls: normalizeImageUrls(post.image_urls),
    status: post.status || 'active',
    is_pinned: Boolean(post.is_pinned),
    like_count: Number(post.like_count || 0),
    comment_count: Number(post.comment_count || 0),
    echo_count: Number(post.echo_count || 0),
    created_at: post.created_at,
    updated_at: post.updated_at,
  }
}

const AUTHOR_POSTS_DAILY_LIMIT = 5
const AUTHOR_POST_IMAGES_LIMIT = 5

function getUtcDayRange(date = new Date()) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0))
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0, 0, 0))

  return {
    start: start.toISOString(),
    end: end.toISOString(),
  }
}

export async function getAuthorPagePosts(req, res) {
  try {
    const pageUsername = normalizePageUsername(req.params.pageUsername)
    const limit = Math.min(30, Math.max(1, Number(req.query.limit || 20)))

    if (!pageUsername) {
      return res.status(400).json({ ok: false, message: 'Page username is required' })
    }

    const { data: authorPage, error: pageError } = await supabase
      .from('author_pages')
      .select('id')
      .eq('page_username', pageUsername)
      .eq('status', 'active')
      .maybeSingle()

    if (pageError) throw pageError

    if (!authorPage) {
      return res.status(404).json({ ok: false, message: 'Author page not found' })
    }

    const { data: posts, error: postsError } = await supabase
      .from('author_page_posts')
      .select('*')
      .eq('author_page_id', authorPage.id)
      .eq('status', 'active')
      .order('is_pinned', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(limit)

    if (postsError) throw postsError

    return res.status(200).json({
      ok: true,
      posts: (posts || []).map(publicAuthorPost),
    })
  } catch (error) {
    console.error('GET AUTHOR PAGE POSTS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load author posts', error: error.message })
  }
}

export async function createMyAuthorPost(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const content = String(req.body.content || '').trim()
    const postType = String(req.body.post_type || req.body.postType || 'article').trim().toLowerCase()
    const imageUrlsRaw = Array.isArray(req.body.image_urls)
      ? req.body.image_urls
      : Array.isArray(req.body.imageUrls)
        ? req.body.imageUrls
        : []
    const imageUrls = normalizeImageUrls(imageUrlsRaw)
    const allowedTypes = new Set(['article', 'announcement', 'update'])

    if (!content && !imageUrls.length) {
      return res.status(400).json({ ok: false, message: 'Post content or photo is required' })
    }

    if (content.length > 5000) {
      return res.status(400).json({ ok: false, message: 'Post content is too long' })
    }

    if (imageUrlsRaw.length > AUTHOR_POST_IMAGES_LIMIT) {
      return res.status(400).json({
        ok: false,
        message: 'You can add up to 5 photos per post.',
        image_limit: AUTHOR_POST_IMAGES_LIMIT,
      })
    }

    if (imageUrls.length !== imageUrlsRaw.length) {
      return res.status(400).json({ ok: false, message: 'Invalid post photo URL' })
    }

    const { data: authorPage, error: pageError } = await supabase
      .from('author_pages')
      .select('id, user_id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle()

    if (pageError) throw pageError

    if (!authorPage) {
      return res.status(404).json({ ok: false, message: 'Author page not found' })
    }

    const todayRange = getUtcDayRange()

    const { count: todayPostCount, error: countError } = await supabase
      .from('author_page_posts')
      .select('id', { count: 'exact', head: true })
      .eq('author_page_id', authorPage.id)
      .eq('user_id', userId)
      .gte('created_at', todayRange.start)
      .lt('created_at', todayRange.end)

    if (countError) throw countError

    if (Number(todayPostCount || 0) >= AUTHOR_POSTS_DAILY_LIMIT) {
      return res.status(429).json({
        ok: false,
        message: 'You reached today’s posting limit. You can publish up to 5 posts per day.',
        daily_post_limit: AUTHOR_POSTS_DAILY_LIMIT,
        daily_post_count: Number(todayPostCount || 0),
      })
    }

    const { data: createdPost, error: createError } = await supabase
      .from('author_page_posts')
      .insert({
        author_page_id: authorPage.id,
        user_id: userId,
        post_type: allowedTypes.has(postType) ? postType : 'article',
        content,
        image_urls: imageUrls,
        status: 'active',
        is_pinned: false,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (createError) throw createError

    return res.status(201).json({
      ok: true,
      message: 'Post created',
      post: publicAuthorPost(createdPost),
      daily_post_limit: AUTHOR_POSTS_DAILY_LIMIT,
      daily_post_count: Number(todayPostCount || 0) + 1,
    })
  } catch (error) {
    console.error('CREATE MY AUTHOR POST ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to create author post', error: error.message })
  }
}

export async function setMyAuthorPostPinned(req, res) {
  try {
    const userId = req.user?.user_id
    const postId = req.params.postId
    const isPinned = Boolean(req.body?.is_pinned ?? req.body?.pinned)

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!postId) {
      return res.status(400).json({ ok: false, message: 'Post ID is required' })
    }

    const { data: authorPage, error: pageError } = await supabase
      .from('author_pages')
      .select('id, user_id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle()

    if (pageError) throw pageError

    if (!authorPage) {
      return res.status(404).json({ ok: false, message: 'Author page not found' })
    }

    const { data: existingPost, error: postError } = await supabase
      .from('author_page_posts')
      .select('id, author_page_id, status')
      .eq('id', postId)
      .eq('author_page_id', authorPage.id)
      .eq('status', 'active')
      .maybeSingle()

    if (postError) throw postError

    if (!existingPost) {
      return res.status(404).json({ ok: false, message: 'Post not found' })
    }

    const now = new Date().toISOString()

    if (isPinned) {
      const { error: unpinError } = await supabase
        .from('author_page_posts')
        .update({
          is_pinned: false,
          updated_at: now,
        })
        .eq('author_page_id', authorPage.id)
        .neq('id', postId)

      if (unpinError) throw unpinError
    }

    const { data: updatedPost, error: updateError } = await supabase
      .from('author_page_posts')
      .update({
        is_pinned: isPinned,
        updated_at: now,
      })
      .eq('id', postId)
      .eq('author_page_id', authorPage.id)
      .select()
      .single()

    if (updateError) throw updateError

    return res.status(200).json({
      ok: true,
      message: isPinned ? 'Post pinned' : 'Post unpinned',
      post: publicAuthorPost(updatedPost),
    })
  } catch (error) {
    console.error('SET MY AUTHOR POST PINNED ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to update pinned post', error: error.message })
  }
}

export async function setMyAuthorPostReaction(req, res) {
  try {
    const userId = req.user?.user_id
    const postId = req.params.postId
    const reactionType = String(req.body?.reaction_type || req.body?.reactionType || 'love').trim().toLowerCase()
    const allowedReactions = new Set(['love', 'haha', 'wow', 'sad', 'angry', 'support', 'touched'])

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!postId) {
      return res.status(400).json({ ok: false, message: 'Post ID is required' })
    }

    if (!allowedReactions.has(reactionType)) {
      return res.status(400).json({ ok: false, message: 'Invalid reaction type' })
    }

    const { data: post, error: postError } = await supabase
      .from('author_page_posts')
      .select('*')
      .eq('id', postId)
      .eq('status', 'active')
      .maybeSingle()

    if (postError) throw postError

    if (!post) {
      return res.status(404).json({ ok: false, message: 'Post not found' })
    }

    const { data: existingReaction, error: existingError } = await supabase
      .from('author_page_post_reactions')
      .select('id, reaction_type')
      .eq('post_id', postId)
      .eq('user_id', userId)
      .maybeSingle()

    if (existingError) throw existingError

    let reacted = true
    let nextReactionType = reactionType

    if (existingReaction?.reaction_type === reactionType) {
      const { error: deleteError } = await supabase
        .from('author_page_post_reactions')
        .delete()
        .eq('id', existingReaction.id)

      if (deleteError) throw deleteError

      reacted = false
      nextReactionType = null
    } else if (existingReaction?.id) {
      const { error: updateReactionError } = await supabase
        .from('author_page_post_reactions')
        .update({
          reaction_type: reactionType,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingReaction.id)

      if (updateReactionError) throw updateReactionError
    } else {
      const { error: insertReactionError } = await supabase
        .from('author_page_post_reactions')
        .insert({
          post_id: postId,
          user_id: userId,
          reaction_type: reactionType,
        })

      if (insertReactionError) throw insertReactionError
    }

    const { count, error: countError } = await supabase
      .from('author_page_post_reactions')
      .select('id', { count: 'exact', head: true })
      .eq('post_id', postId)

    if (countError) throw countError

    const nextLikeCount = Number(count || 0)

    const { data: updatedPost, error: updatePostError } = await supabase
      .from('author_page_posts')
      .update({
        like_count: nextLikeCount,
        updated_at: new Date().toISOString(),
      })
      .eq('id', postId)
      .select()
      .single()

    if (updatePostError) throw updatePostError

    return res.status(200).json({
      ok: true,
      reacted,
      reaction_type: nextReactionType,
      like_count: nextLikeCount,
      post: publicAuthorPost(updatedPost),
    })
  } catch (error) {
    console.error('SET MY AUTHOR POST REACTION ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to update post reaction', error: error.message })
  }
}


function publicAuthorPostComment(comment) {
  return {
    id: comment.id,
    post_id: comment.post_id,
    user_id: comment.user_id,
    parent_id: comment.parent_id,
    text: comment.text || '',
    is_hidden: Boolean(comment.is_hidden),
    is_pinned: Boolean(comment.is_pinned),
    likes: Number(comment.likes || 0),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    user: comment.user
      ? {
          id: comment.user.id,
          name: comment.user.name || comment.user.username || 'Reader',
          username: comment.user.username || '',
          avatar_url: comment.user.avatar_url || '',
          role: comment.user.role || 'reader',
        }
      : {
          id: null,
          name: 'Reader',
          username: '',
          avatar_url: '',
          role: 'reader',
        },
  }
}

export async function getAuthorPostComments(req, res) {
  try {
    const postId = req.params.postId
    const limit = Math.min(30, Math.max(1, Number(req.query.limit || 20)))

    if (!postId) {
      return res.status(400).json({ ok: false, message: 'Post ID is required' })
    }

    const { data: post, error: postError } = await supabase
      .from('author_page_posts')
      .select('id, status')
      .eq('id', postId)
      .eq('status', 'active')
      .maybeSingle()

    if (postError) throw postError

    if (!post) {
      return res.status(404).json({ ok: false, message: 'Post not found' })
    }

    const { data: comments, error: commentsError } = await supabase
      .from('author_page_post_comments')
      .select('*, user:users(id, name, username, avatar_url, role)')
      .eq('post_id', postId)
      .eq('is_hidden', false)
      .is('parent_id', null)
      .order('is_pinned', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(limit)

    if (commentsError) throw commentsError

    return res.status(200).json({
      ok: true,
      comments: (comments || []).map(publicAuthorPostComment),
    })
  } catch (error) {
    console.error('GET AUTHOR POST COMMENTS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load post comments', error: error.message })
  }
}

export async function createAuthorPostComment(req, res) {
  try {
    const userId = req.user?.user_id
    const postId = req.params.postId
    const text = String(req.body.text || '').trim()

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!postId) {
      return res.status(400).json({ ok: false, message: 'Post ID is required' })
    }

    if (!text) {
      return res.status(400).json({ ok: false, message: 'Comment text is required' })
    }

    if (text.length > 1000) {
      return res.status(400).json({ ok: false, message: 'Comment is too long' })
    }

    const { data: post, error: postError } = await supabase
      .from('author_page_posts')
      .select('id, status, comment_count')
      .eq('id', postId)
      .eq('status', 'active')
      .maybeSingle()

    if (postError) throw postError

    if (!post) {
      return res.status(404).json({ ok: false, message: 'Post not found' })
    }

    const { data: createdComment, error: createError } = await supabase
      .from('author_page_post_comments')
      .insert({
        post_id: postId,
        user_id: userId,
        text,
      })
      .select('*, user:users(id, name, username, avatar_url, role)')
      .single()

    if (createError) throw createError

    const { count, error: countError } = await supabase
      .from('author_page_post_comments')
      .select('id', { count: 'exact', head: true })
      .eq('post_id', postId)
      .eq('is_hidden', false)

    if (countError) throw countError

    const nextCommentCount = Number(count || 0)

    const { error: updatePostError } = await supabase
      .from('author_page_posts')
      .update({
        comment_count: nextCommentCount,
        updated_at: new Date().toISOString(),
      })
      .eq('id', postId)

    if (updatePostError) throw updatePostError

    return res.status(201).json({
      ok: true,
      comment: publicAuthorPostComment(createdComment),
      comment_count: nextCommentCount,
    })
  } catch (error) {
    console.error('CREATE AUTHOR POST COMMENT ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to create post comment', error: error.message })
  }
}
