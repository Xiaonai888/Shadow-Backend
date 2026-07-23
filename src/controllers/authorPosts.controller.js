import { supabase } from '../config/supabase.js'
import { incrementAuthorPageAnalytics } from '../services/authorAnalytics.service.js'
import {
  deleteAuthorPageCommentToTrash,
  getCommentTrashMessage,
  getCommentTrashStatus,
} from '../services/commentTrash.service.js'

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
    reaction_summary: Array.isArray(post.reaction_summary) ? post.reaction_summary.slice(0, 3) : [],
    created_at: post.created_at,
    updated_at: post.updated_at,
  }
}

const AUTHOR_POSTS_DAILY_LIMIT = 5
const AUTHOR_POST_IMAGES_LIMIT = 5
const AUTHOR_POST_CONTENT_LIMIT = 10000

function getUtcDayRange(date = new Date()) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0))
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0, 0, 0))

  return {
    start: start.toISOString(),
    end: end.toISOString(),
  }
}

function buildReactionSummaryMap(reactions = []) {
  const reactionOrder = ['love', 'haha', 'wow', 'sad', 'angry', 'support', 'touched']
  const reactionRank = new Map(reactionOrder.map((type, index) => [type, index]))
  const countsByPost = new Map()

  for (const item of reactions || []) {
    const postId = item?.post_id
    const reactionType = String(item?.reaction_type || '').trim().toLowerCase()

    if (!postId || !reactionType) continue

    if (!countsByPost.has(postId)) {
      countsByPost.set(postId, new Map())
    }

    const postCounts = countsByPost.get(postId)
    postCounts.set(reactionType, Number(postCounts.get(reactionType) || 0) + 1)
  }

  const summaryByPost = new Map()

  for (const [postId, counts] of countsByPost.entries()) {
    const summary = [...counts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count
        return Number(reactionRank.get(a.type) ?? 99) - Number(reactionRank.get(b.type) ?? 99)
      })
      .slice(0, 3)

    summaryByPost.set(postId, summary)
  }

  return summaryByPost
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

    const postIds = (posts || []).map((post) => post.id).filter(Boolean)
let reactionSummaryByPost = new Map()

if (postIds.length) {
  const { data: reactionRows, error: reactionSummaryError } = await supabase
    .from('author_page_post_reactions')
    .select('post_id, reaction_type')
    .in('post_id', postIds)

  if (reactionSummaryError) throw reactionSummaryError

  reactionSummaryByPost = buildReactionSummaryMap(reactionRows || [])
}

return res.status(200).json({
  ok: true,
  posts: (posts || []).map((post) =>
    publicAuthorPost({
      ...post,
      reaction_summary: reactionSummaryByPost.get(post.id) || [],
    })
  ),
})
  } catch (error) {
    console.error('GET AUTHOR PAGE POSTS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load author posts', error: error.message })
  }
}

export async function getAuthorPostById(req, res) {
  try {
    const postId = req.params.postId

    if (!postId) {
      return res.status(400).json({ ok: false, message: 'Post ID is required' })
    }

    const { data: post, error } = await supabase
      .from('author_page_posts')
      .select('*, author_page:author_pages(id, page_name, page_username, avatar_url)')
      .eq('id', postId)
      .eq('status', 'active')
      .maybeSingle()

    if (error) throw error

    if (!post) {
      return res.status(404).json({ ok: false, message: 'Post not found' })
    }

    return res.status(200).json({
      ok: true,
      post: {
        ...publicAuthorPost(post),
        author_page: post.author_page || null,
      },
    })
  } catch (error) {
    console.error('GET AUTHOR POST BY ID ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load author post', error: error.message })
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

    if (content.length > AUTHOR_POST_CONTENT_LIMIT) {
      return res.status(400).json({
        ok: false,
        message: `Post content must be ${AUTHOR_POST_CONTENT_LIMIT.toLocaleString()} characters or fewer`,
      })
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
    const reactionType = String(
      req.body?.reaction_type ||
      req.body?.reactionType ||
      'love'
    ).trim().toLowerCase()

    const allowedReactions = new Set([
      'love',
      'haha',
      'wow',
      'sad',
      'angry',
      'support',
      'touched',
    ])

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!postId) {
      return res.status(400).json({
        ok: false,
        message: 'Post ID is required',
      })
    }

    if (!allowedReactions.has(reactionType)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid reaction type',
      })
    }

    const { data: post, error: postError } = await supabase
      .from('author_page_posts')
      .select('*')
      .eq('id', postId)
      .eq('status', 'active')
      .maybeSingle()

    if (postError) throw postError

    if (!post) {
      return res.status(404).json({
        ok: false,
        message: 'Post not found',
      })
    }

    const { data: existingReaction, error: existingError } =
      await supabase
        .from('author_page_post_reactions')
        .select('id, reaction_type')
        .eq('post_id', postId)
        .eq('user_id', userId)
        .maybeSingle()

    if (existingError) throw existingError

    let reacted = true
    let nextReactionType = reactionType
    let interactionCreated = false

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

      interactionCreated = true
    }

    const { data: reactionRows, error: reactionSummaryError } =
      await supabase
        .from('author_page_post_reactions')
        .select('post_id, reaction_type')
        .eq('post_id', postId)

    if (reactionSummaryError) throw reactionSummaryError

    const reactionSummary =
      buildReactionSummaryMap(reactionRows || []).get(postId) || []

    const nextLikeCount = Number((reactionRows || []).length)

    const { data: updatedPost, error: updatePostError } =
      await supabase
        .from('author_page_posts')
        .update({
          like_count: nextLikeCount,
          updated_at: new Date().toISOString(),
        })
        .eq('id', postId)
        .select()
        .single()

    if (updatePostError) throw updatePostError

    const isOwner =
      String(post.user_id || '') === String(userId)

    if (
      interactionCreated &&
      !isOwner &&
      post.author_page_id
    ) {
      await incrementAuthorPageAnalytics(
        post.author_page_id,
        'interactions'
      )
    }

    return res.status(200).json({
      ok: true,
      reacted,
      reaction_type: nextReactionType,
      like_count: nextLikeCount,
      reaction_summary: reactionSummary,
      post: publicAuthorPost({
        ...updatedPost,
        reaction_summary: reactionSummary,
      }),
    })
  } catch (error) {
    console.error(
      'SET MY AUTHOR POST REACTION ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message: 'Failed to update post reaction',
      error: error.message,
    })
  }
}

export async function getAuthorPostReactions(req, res) {
  try {
    const postId = String(req.params.postId || '').trim()
    const page = Math.max(1, Number(req.query.page || 1))
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)))
    const from = (page - 1) * limit
    const to = from + limit - 1

    if (!postId) {
      return res.status(400).json({
        ok: false,
        message: 'Post ID is required',
      })
    }

    const { data: post, error: postError } = await supabase
      .from('author_page_posts')
      .select('id, content, status')
      .eq('id', postId)
      .eq('status', 'active')
      .maybeSingle()

    if (postError) throw postError

    if (!post) {
      return res.status(404).json({
        ok: false,
        message: 'Post not found',
      })
    }

    const { data: countRows, error: countError } = await supabase
      .from('author_page_post_reactions')
      .select('reaction_type')
      .eq('post_id', postId)

    if (countError) throw countError

    const counts = (countRows || []).reduce((result, item) => {
      const type = String(item.reaction_type || 'love')
        .trim()
        .toLowerCase()

      result[type] = Number(result[type] || 0) + 1
      return result
    }, {})

    const { data, error, count } = await supabase
      .from('author_page_post_reactions')
      .select(
        'id, user_id, reaction_type, created_at, user:users(id, name, username, avatar_url)',
        { count: 'exact' }
      )
      .eq('post_id', postId)
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) throw error

    const reactions = (data || []).map((item) => {
      const user = Array.isArray(item.user) ? item.user[0] : item.user

      return {
        id: item.id,
        reaction_type: item.reaction_type || 'love',
        created_at: item.created_at,
        user: {
          id: user?.id || item.user_id,
          name: user?.name || user?.username || 'Reader',
          username: user?.username || '',
          avatar_url: user?.avatar_url || '',
        },
      }
    })

    const total = Number(count || 0)

    return res.status(200).json({
      ok: true,
      post: {
        id: post.id,
        content: String(post.content || '').slice(0, 120),
      },
      total,
      counts,
      page,
      limit,
      has_more: to + 1 < total,
      reactions,
    })
  } catch (error) {
    console.error('GET AUTHOR POST REACTIONS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load post reactions',
      error: error.message,
    })
  }
}


function publicAuthorPostComment(comment) {
  const isDeleted = Boolean(comment.deleted_at)

  return {
    id: comment.id,
    post_id: comment.post_id,
    user_id: isDeleted ? null : comment.user_id,
    parent_id: comment.parent_id,
    text: isDeleted ? 'Comment deleted' : comment.text || '',
    is_deleted: isDeleted,
    is_hidden: isDeleted ? false : Boolean(comment.is_hidden),
    is_pinned: isDeleted ? false : Boolean(comment.is_pinned),
    likes: isDeleted ? 0 : Number(comment.likes || 0),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    user: isDeleted
      ? {
          id: null,
          name: 'Reader',
          username: '',
          avatar_url: '',
          role: 'reader',
        }
      : comment.user
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
    replies: Array.isArray(comment.replies)
      ? comment.replies.map(publicAuthorPostComment)
      : [],
  }
}

export async function getAuthorPostComments(req, res) {
  try {
    const postId = String(req.params.postId || '').trim()
    const limit = Math.min(30, Math.max(1, Number(req.query.limit || 20)))

    if (!postId) {
      return res.status(400).json({
        ok: false,
        message: 'Post ID is required',
      })
    }

    const { data: post, error: postError } = await supabase
      .from('author_page_posts')
      .select('id, status')
      .eq('id', postId)
      .eq('status', 'active')
      .maybeSingle()

    if (postError) throw postError

    if (!post) {
      return res.status(404).json({
        ok: false,
        message: 'Post not found',
      })
    }

    const { data: parentComments, error: commentsError } = await supabase
      .from('author_page_post_comments')
      .select('*, user:users(id, name, username, avatar_url, role)')
      .eq('post_id', postId)
      .eq('is_hidden', false)
      .is('deleted_at', null)
      .is('parent_id', null)
      .order('is_pinned', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(limit)

    if (commentsError) throw commentsError

    const { data: deletedRows, error: deletedError } = await supabase
      .from('author_page_post_comments')
      .select('*, user:users(id, name, username, avatar_url, role)')
      .eq('post_id', postId)
      .eq('is_hidden', false)
      .not('deleted_at', 'is', null)
      .is('parent_id', null)
      .order('deleted_at', { ascending: false })
      .limit(Math.min(100, limit * 5))

    if (deletedError) throw deletedError

    const deletedParents = deletedRows || []
    const candidateParents = [...(parentComments || []), ...deletedParents]
    const candidateIds = candidateParents
      .map((comment) => comment.id)
      .filter(Boolean)
    let replies = []

    if (candidateIds.length) {
      const { data: replyRows, error: repliesError } = await supabase
        .from('author_page_post_comments')
        .select('*, user:users(id, name, username, avatar_url, role)')
        .eq('post_id', postId)
        .eq('is_hidden', false)
        .is('deleted_at', null)
        .in('parent_id', candidateIds)
        .order('created_at', { ascending: true })

      if (repliesError) throw repliesError
      replies = replyRows || []
    }

    const replyParentIds = new Set(
      replies.map((reply) => String(reply.parent_id || ''))
    )
    const visibleDeletedParents = deletedParents.filter((comment) =>
      replyParentIds.has(String(comment.id))
    )
    const visibleParents = [
      ...(parentComments || []),
      ...visibleDeletedParents,
    ]
    const repliesByParent = new Map()

    for (const reply of replies) {
      const key = String(reply.parent_id || '')
      const current = repliesByParent.get(key) || []
      current.push(reply)
      repliesByParent.set(key, current)
    }

    const comments = visibleParents.map((comment) => ({
      ...comment,
      replies: repliesByParent.get(String(comment.id)) || [],
    }))

    const { count, error: countError } = await supabase
      .from('author_page_post_comments')
      .select('id', {
        count: 'exact',
        head: true,
      })
      .eq('post_id', postId)
      .eq('is_hidden', false)
      .is('deleted_at', null)

    if (countError) throw countError

    return res.status(200).json({
      ok: true,
      comments: comments.map(publicAuthorPostComment),
      total: Number(count || 0),
      has_more: false,
    })
  } catch (error) {
    console.error('GET AUTHOR POST COMMENTS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load post comments',
      error: error.message,
    })
  }
}

export async function createAuthorPostComment(req, res) {
  try {
    const userId = req.user?.user_id
    const postId = String(req.params.postId || '').trim()
    const text = String(req.body.text || '').trim()
    const parentId =
      String(req.body.parent_id || req.body.parentId || '').trim() || null

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!postId) {
      return res.status(400).json({
        ok: false,
        message: 'Post ID is required',
      })
    }

    if (!text) {
      return res.status(400).json({
        ok: false,
        message: 'Comment text is required',
      })
    }

    if (text.length > 1000) {
      return res.status(400).json({
        ok: false,
        message: 'Comment is too long',
      })
    }

    const { data: post, error: postError } = await supabase
      .from('author_page_posts')
      .select('id, author_page_id, user_id, status, comment_count')
      .eq('id', postId)
      .eq('status', 'active')
      .maybeSingle()

    if (postError) throw postError

    if (!post) {
      return res.status(404).json({
        ok: false,
        message: 'Post not found',
      })
    }

    if (parentId) {
      const { data: parentComment, error: parentError } = await supabase
        .from('author_page_post_comments')
        .select('id, post_id, parent_id, is_hidden')
        .eq('id', parentId)
        .eq('post_id', postId)
        .eq('is_hidden', false)
        .is('deleted_at', null)
        .maybeSingle()

      if (parentError) throw parentError

      if (!parentComment || parentComment.parent_id) {
        return res.status(400).json({
          ok: false,
          message: 'Reply target is not valid',
        })
      }
    }

    const { data: createdComment, error: createError } = await supabase
      .from('author_page_post_comments')
      .insert({
        post_id: postId,
        user_id: userId,
        parent_id: parentId,
        text,
      })
      .select('*, user:users(id, name, username, avatar_url, role)')
      .single()

    if (createError) throw createError

    const { count, error: countError } = await supabase
      .from('author_page_post_comments')
      .select('id', {
        count: 'exact',
        head: true,
      })
      .eq('post_id', postId)
      .eq('is_hidden', false)
      .is('deleted_at', null)

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

    const isOwner = String(post.user_id || '') === String(userId)

    if (!isOwner && post.author_page_id) {
      await Promise.all([
        incrementAuthorPageAnalytics(post.author_page_id, 'comments'),
        incrementAuthorPageAnalytics(post.author_page_id, 'interactions'),
      ])
    }

    return res.status(201).json({
      ok: true,
      comment: publicAuthorPostComment(createdComment),
      comment_count: nextCommentCount,
    })
  } catch (error) {
    console.error('CREATE AUTHOR POST COMMENT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to create post comment',
      error: error.message,
    })
  }
}

export async function updateOwnAuthorPostComment(req, res) {
  try {
    const userId = req.user?.user_id
    const commentId = String(req.params.commentId || '').trim()
    const text = String(req.body.text || '').trim()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!commentId) {
      return res.status(400).json({
        ok: false,
        message: 'Comment ID is required',
      })
    }

    if (!text) {
      return res.status(400).json({
        ok: false,
        message: 'Comment text is required',
      })
    }

    if (text.length > 1000) {
      return res.status(400).json({
        ok: false,
        message: 'Comment is too long',
      })
    }

    const { data: existingComment, error: findError } = await supabase
      .from('author_page_post_comments')
      .select('id, user_id')
      .eq('id', commentId)
      .is('deleted_at', null)
      .maybeSingle()

    if (findError) throw findError

    if (!existingComment) {
      return res.status(404).json({
        ok: false,
        message: 'Comment not found',
      })
    }

    if (String(existingComment.user_id) !== String(userId)) {
      return res.status(403).json({
        ok: false,
        message: 'You can only edit your own comment',
      })
    }

    const { data: updatedComment, error: updateError } = await supabase
      .from('author_page_post_comments')
      .update({
        text,
        updated_at: new Date().toISOString(),
      })
      .eq('id', commentId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .select('*, user:users(id, name, username, avatar_url, role)')
      .single()

    if (updateError) throw updateError

    return res.status(200).json({
      ok: true,
      comment: publicAuthorPostComment(updatedComment),
    })
  } catch (error) {
    console.error('UPDATE OWN AUTHOR POST COMMENT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to update comment',
      error: error.message,
    })
  }
}

export async function deleteOwnAuthorPostComment(req, res) {
  try {
    const userId = req.user?.user_id
    const commentId = String(req.params.commentId || '').trim()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!commentId) {
      return res.status(400).json({
        ok: false,
        message: 'Comment ID is required',
      })
    }

    const { data: comment, error: commentError } = await supabase
      .from('author_page_post_comments')
      .select('id, post_id, user_id')
      .eq('id', commentId)
      .is('deleted_at', null)
      .maybeSingle()

    if (commentError) throw commentError

    if (!comment) {
      return res.status(404).json({
        ok: false,
        message: 'Comment not found',
      })
    }

    const { data: post, error: postError } = await supabase
      .from('author_page_posts')
      .select('id, user_id')
      .eq('id', comment.post_id)
      .maybeSingle()

    if (postError) throw postError

    if (!post) {
      return res.status(404).json({
        ok: false,
        message: 'Author Page post not found',
      })
    }

    const ownsComment =
      String(comment.user_id || '') === String(userId)
    const ownsAuthorPage =
      String(post.user_id || '') === String(userId)

    if (!ownsComment && !ownsAuthorPage) {
      return res.status(403).json({
        ok: false,
        message: 'You cannot delete this comment',
      })
    }

    const result = await deleteAuthorPageCommentToTrash({
      commentId,
      actorType: ownsComment ? 'reader' : 'author',
      actorId: String(userId),
      reason: String(req.body?.reason || '').trim(),
    })

    if (!result.ok) {
      const status = getCommentTrashStatus(result)

      if (result.retry_after_seconds) {
        res.setHeader(
          'Retry-After',
          String(result.retry_after_seconds)
        )
      }

      return res.status(status).json({
        ok: false,
        code: result.code,
        message: getCommentTrashMessage(result),
        limit: result.limit ?? null,
        used: result.used ?? null,
        remaining: result.remaining ?? null,
        retry_after_seconds:
          result.retry_after_seconds ?? 0,
      })
    }

    return res.status(200).json({
      ok: true,
      message: 'Comment moved to trash',
      comment_id: result.comment_id,
      deleted_at: result.deleted_at,
      delete_expires_at: result.delete_expires_at,
      limit: result.limit ?? null,
      used: result.used ?? null,
      remaining: result.remaining ?? null,
    })
  } catch (error) {
    console.error('DELETE AUTHOR POST COMMENT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to delete comment',
      error: error.message,
    })
  }
}

