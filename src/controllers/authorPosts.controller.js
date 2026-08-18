import jwt from 'jsonwebtoken'
import { supabase } from '../config/supabase.js'
import { incrementAuthorPageAnalytics } from '../services/authorAnalytics.service.js'
import {
  createAuthorPageNotificationSafely,
  deleteAuthorPageNotificationBySourceKeySafely,
} from '../services/authorPageNotifications.service.js'
import {
  deleteAuthorPageCommentToTrash,
  getCommentTrashMessage,
  getCommentTrashStatus,
} from '../services/commentTrash.service.js'
import {
  authorReaderBlockedPayload,
  getActiveAuthorReaderBlock,
} from '../utils/authorReaderCommentBlocks.js'

function getRequestUserId(req) {
  try {
    const authHeader =
      req.headers.authorization || ''
    const token = authHeader.startsWith(
      'Bearer '
    )
      ? authHeader.slice(7)
      : ''

    if (!token) return null

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    )

    return decoded.type === 'reader'
      ? decoded.user_id || null
      : null
  } catch {
    return null
  }
}

async function getAuthorPostCommentLikedIds(
  userId,
  commentIds
) {
  if (!userId || !commentIds.length) {
    return new Set()
  }

  const { data, error } = await supabase
    .from('author_page_post_comment_likes')
    .select('comment_id')
    .eq('user_id', userId)
    .in('comment_id', commentIds)

  if (error) throw error

  return new Set(
    (data || []).map((item) =>
      String(item.comment_id)
    )
  )
}

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
photo_metadata: normalizePhotoMetadata(
  post.photo_metadata,
  normalizeImageUrls(post.image_urls)
),
status: post.status || 'active',
    is_pinned: Boolean(post.is_pinned),
    pinned_at: post.pinned_at || null,
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
const AUTHOR_PHOTO_CAPTION_LIMIT = 2000
const AUTHOR_PHOTO_ALT_TEXT_LIMIT = 500

function normalizePhotoMetadata(
  value,
  imageUrls = [],
  fallback = []
) {
  const source =
    value === undefined
      ? fallback
      : value

  if (
    source !== null &&
    !Array.isArray(source)
  ) {
    const error = new Error(
      'Photo metadata must be an array'
    )
    error.statusCode = 400
    throw error
  }

  const items = Array.isArray(source)
    ? source
    : []

  const byUrl = new Map()

  for (const item of items) {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item)
    ) {
      continue
    }

    const url = String(
      item.url || ''
    ).trim()

    if (url) {
      byUrl.set(url, item)
    }
  }

  return imageUrls.map((url, index) => {
    const indexedItem =
      items[index] &&
      typeof items[index] === 'object' &&
      !Array.isArray(items[index])
        ? items[index]
        : {}

    const item =
      byUrl.get(url) ||
      indexedItem

    const caption = String(
      item.caption || ''
    )
      .replace(/\r\n/g, '\n')
      .trim()

    const altText = String(
      item.alt_text ??
        item.alt ??
        ''
    )
      .replace(/\r\n/g, '\n')
      .trim()

    if (
      caption.length >
      AUTHOR_PHOTO_CAPTION_LIMIT
    ) {
      const error = new Error(
        `Photo caption must be ${AUTHOR_PHOTO_CAPTION_LIMIT} characters or fewer`
      )
      error.statusCode = 400
      throw error
    }

    if (
      altText.length >
      AUTHOR_PHOTO_ALT_TEXT_LIMIT
    ) {
      const error = new Error(
        `Photo alt text must be ${AUTHOR_PHOTO_ALT_TEXT_LIMIT} characters or fewer`
      )
      error.statusCode = 400
      throw error
    }

    return {
      url,
      caption,
      alt_text: altText,
    }
  })
}

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

    let postsQuery = supabase
      .from('author_page_posts')
      .select('*')
      .eq('author_page_id', authorPage.id)
      .eq('status', 'active')

    const before = String(req.query.before || '').trim()

    if (before) {
      const beforeDate = new Date(`${before}T23:59:59.999Z`)

      if (!Number.isNaN(beforeDate.getTime())) {
        postsQuery = postsQuery.lte('created_at', beforeDate.toISOString())
      }
    }

    const { data: posts, error: postsError } = await postsQuery
      .order('is_pinned', { ascending: false })
      .order('pinned_at', { ascending: false, nullsFirst: false })
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
    const viewerUserId = getRequestUserId(req)

    if (!postId) {
      return res.status(400).json({
        ok: false,
        message: 'Post ID is required',
      })
    }

    const { data: post, error } = await supabase
      .from('author_page_posts')
      .select(
        '*, author_page:author_pages(id, user_id, page_name, page_username, avatar_url, total_followers)'
      )
      .eq('id', postId)
      .eq('status', 'active')
      .maybeSingle()

    if (error) throw error

    if (!post) {
      return res.status(404).json({
        ok: false,
        message: 'Post not found',
      })
    }

    const authorPage = Array.isArray(post.author_page)
      ? post.author_page[0] || null
      : post.author_page || null

    const {
      data: reactionRows,
      error: reactionsError,
    } = await supabase
      .from('author_page_post_reactions')
      .select('post_id, user_id, reaction_type')
      .eq('post_id', postId)

    if (reactionsError) throw reactionsError

    const reactionSummary =
      buildReactionSummaryMap(
        reactionRows || []
      ).get(postId) || []

    const myReaction = viewerUserId
      ? (
          reactionRows || []
        ).find(
          (item) =>
            String(item.user_id) ===
            String(viewerUserId)
        )?.reaction_type || null
      : null

    let isFollowing = false

    if (viewerUserId && authorPage?.id) {
      const {
        data: followRow,
        error: followError,
      } = await supabase
        .from('author_page_follows')
        .select('id')
        .eq('author_page_id', authorPage.id)
        .eq('follower_user_id', viewerUserId)
        .maybeSingle()

      if (followError) throw followError

      isFollowing = Boolean(followRow)
    }

    const isOwner = Boolean(
      viewerUserId &&
      authorPage?.user_id &&
      String(authorPage.user_id) ===
        String(viewerUserId)
    )

    const normalizedAuthorPage = authorPage
      ? {
          ...authorPage,
          is_following: isFollowing,
          is_owner: isOwner,
        }
      : null

    return res.status(200).json({
      ok: true,
      post: {
        ...publicAuthorPost({
          ...post,
          like_count: Number(
            (reactionRows || []).length
          ),
          reaction_summary:
            reactionSummary,
        }),
        my_reaction: myReaction,
        is_following: isFollowing,
        is_owner: isOwner,
        author_page:
          normalizedAuthorPage,
      },
    })
  } catch (error) {
    console.error(
      'GET AUTHOR POST BY ID ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to load author post',
      error: error.message,
    })
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
const photoMetadata = normalizePhotoMetadata(
  req.body.photo_metadata,
  imageUrls
)
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
        photo_metadata: photoMetadata,
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
    return res.status(error.statusCode || 500).json({ ok: false, message: error.message || 'Failed to create author post' })
  }
}

export async function updateMyAuthorPost(req, res) {
  try {
    const userId = req.user?.user_id || req.user?.id
    const postId = String(req.params.postId || '').trim()
    const body = req.body || {}
    const hasContent = Object.prototype.hasOwnProperty.call(body, 'content')
const hasImageUrls =
  Object.prototype.hasOwnProperty.call(body, 'image_urls') ||
  Object.prototype.hasOwnProperty.call(body, 'imageUrls')
const hasPhotoMetadata =
  Object.prototype.hasOwnProperty.call(body, 'photo_metadata')

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!postId) {
      return res.status(400).json({ ok: false, message: 'Post ID is required' })
    }

    if (!hasContent && !hasImageUrls && !hasPhotoMetadata) {
      return res.status(400).json({ ok: false, message: 'Nothing to update' })
    }

    const nextContent = hasContent
      ? String(body.content || '').trim()
      : null

    if (hasContent && nextContent.length > AUTHOR_POST_CONTENT_LIMIT) {
      return res.status(400).json({
        ok: false,
        message: `Post content must be ${AUTHOR_POST_CONTENT_LIMIT.toLocaleString()} characters or fewer`,
      })
    }

    let imageUrlsRaw = null
    let imageUrls = null

    if (hasImageUrls) {
      imageUrlsRaw = Object.prototype.hasOwnProperty.call(body, 'image_urls')
        ? body.image_urls
        : body.imageUrls

      if (!Array.isArray(imageUrlsRaw)) {
        return res.status(400).json({
          ok: false,
          message: 'Post photos must be an array',
        })
      }

      if (imageUrlsRaw.length > AUTHOR_POST_IMAGES_LIMIT) {
        return res.status(400).json({
          ok: false,
          message: 'You can add up to 5 photos per post.',
          image_limit: AUTHOR_POST_IMAGES_LIMIT,
        })
      }

      imageUrls = normalizeImageUrls(imageUrlsRaw)

      if (imageUrls.length !== imageUrlsRaw.length) {
        return res.status(400).json({
          ok: false,
          message: 'Invalid post photo URL',
        })
      }
    }

    const { data: authorPage, error: pageError } = await supabase
      .from('author_pages')
      .select('id, user_id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle()

    if (pageError) throw pageError

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message: 'Author page not found',
      })
    }

    const { data: existingPost, error: postError } = await supabase
      .from('author_page_posts')
      .select('*')
      .eq('id', postId)
      .eq('author_page_id', authorPage.id)
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle()

    if (postError) throw postError

    if (!existingPost) {
      return res.status(404).json({
        ok: false,
        message: 'Post not found',
      })
    }

    const finalContent = hasContent
      ? nextContent
      : String(existingPost.content || '').trim()

    const finalImageUrls = hasImageUrls
  ? imageUrls
  : normalizeImageUrls(existingPost.image_urls)

const finalPhotoMetadata =
  normalizePhotoMetadata(
    hasPhotoMetadata
      ? body.photo_metadata
      : undefined,
    finalImageUrls,
    existingPost.photo_metadata
  )

if (!finalContent && !finalImageUrls.length) {
      return res.status(400).json({
        ok: false,
        message: 'Post content or photo is required',
      })
    }

    const updates = {
      updated_at: new Date().toISOString(),
    }

    if (hasContent) updates.content = finalContent
if (hasImageUrls) updates.image_urls = finalImageUrls
if (hasImageUrls || hasPhotoMetadata) {
  updates.photo_metadata =
    finalPhotoMetadata
}

    const { data: updatedPost, error: updateError } = await supabase
      .from('author_page_posts')
      .update(updates)
      .eq('id', postId)
      .eq('author_page_id', authorPage.id)
      .eq('user_id', userId)
      .eq('status', 'active')
      .select()
      .single()

    if (updateError) throw updateError

    return res.status(200).json({
      ok: true,
      message: 'Post updated',
      post: publicAuthorPost(updatedPost),
    })
  } catch (error) {
    console.error('UPDATE MY AUTHOR POST ERROR:', error)

    return res.status(error.statusCode || 500).json({
      ok: false,
      message: 'Failed to update author post',
      error: error.message,
    })
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
      .select('id, author_page_id, status, is_pinned, pinned_at')
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
      const { data: pinnedPosts, error: pinnedError } = await supabase
        .from('author_page_posts')
        .select('id, pinned_at, updated_at, created_at')
        .eq('author_page_id', authorPage.id)
        .eq('status', 'active')
        .eq('is_pinned', true)
        .neq('id', postId)

      if (pinnedError) throw pinnedError

      const sortedPinnedPosts = [...(pinnedPosts || [])].sort((a, b) => {
        const aTime = new Date(a.pinned_at || a.updated_at || a.created_at || 0).getTime()
        const bTime = new Date(b.pinned_at || b.updated_at || b.created_at || 0).getTime()
        return aTime - bTime
      })

      const unpinCount = Math.max(0, sortedPinnedPosts.length - 2)
      const oldestPinnedIds = sortedPinnedPosts.slice(0, unpinCount).map((item) => item.id)

      if (oldestPinnedIds.length) {
        const { error: unpinError } = await supabase
          .from('author_page_posts')
          .update({
            is_pinned: false,
            pinned_at: null,
            updated_at: now,
          })
          .in('id', oldestPinnedIds)

        if (unpinError) throw unpinError
      }
    }

    const { data: updatedPost, error: updateError } = await supabase
      .from('author_page_posts')
      .update({
        is_pinned: isPinned,
        pinned_at: isPinned ? now : null,
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

    if (!isOwner && post.author_page_id) {
      const sourceKey = `author-post-reaction:${postId}:${userId}`

      if (!reacted) {
        await deleteAuthorPageNotificationBySourceKeySafely({
          authorPageId: post.author_page_id,
          type: 'reaction',
          sourceKey,
        })
      } else {
        const { data: reader, error: readerError } = await supabase
          .from('users')
          .select('id, name, username, avatar_url')
          .eq('id', userId)
          .maybeSingle()

        if (readerError) throw readerError

        const readerName =
          reader?.name || reader?.username || 'A reader'

        await deleteAuthorPageNotificationBySourceKeySafely({
          authorPageId: post.author_page_id,
          type: 'reaction',
          sourceKey,
        })

        await Promise.all([
          interactionCreated
            ? incrementAuthorPageAnalytics(
                post.author_page_id,
                'interactions'
              )
            : Promise.resolve(),
          createAuthorPageNotificationSafely({
            authorPageId: post.author_page_id,
            authorUserId: post.user_id,
            type: 'reaction',
            title: `${readerName} reacted ${reactionType} to your post`,
            targetUrl: `/author/page?post=${postId}`,
            sourceKey,
            metadata: {
              post_id: postId,
              reaction_type: reactionType,
              reader_id: userId,
              reader_name: readerName,
              reader_username: reader?.username || '',
              reader_avatar_url: reader?.avatar_url || '',
            },
          }),
        ])
      }
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
    const limit = Math.min(
      100,
      Math.max(1, Number(req.query.limit || 50))
    )
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

    const { data: countRows, error: countError } =
      await supabase
        .from('author_page_post_reactions')
        .select('reaction_type')
        .eq('post_id', postId)

    if (countError) throw countError

    const counts = (countRows || []).reduce(
      (result, item) => {
        const type = String(
          item.reaction_type || 'love'
        )
          .trim()
          .toLowerCase()

        result[type] =
          Number(result[type] || 0) + 1
        return result
      },
      {}
    )

    const {
      data: reactionRows,
      error: reactionsError,
      count,
    } = await supabase
      .from('author_page_post_reactions')
      .select(
        'id, user_id, reaction_type, created_at',
        { count: 'exact' }
      )
      .eq('post_id', postId)
      .order('created_at', { ascending: false })
      .range(from, to)

    if (reactionsError) throw reactionsError

    const userIds = [
      ...new Set(
        (reactionRows || [])
          .map((item) => item.user_id)
          .filter(Boolean)
      ),
    ]

    let usersById = new Map()

    if (userIds.length) {
      const { data: users, error: usersError } =
        await supabase
          .from('users')
          .select(
            'id, name, username, avatar_url'
          )
          .in('id', userIds)

      if (usersError) throw usersError

      usersById = new Map(
        (users || []).map((user) => [
          String(user.id),
          user,
        ])
      )
    }

    const reactions = (reactionRows || []).map(
      (item) => {
        const user =
          usersById.get(String(item.user_id)) ||
          {}

        return {
          id: item.id,
          reaction_type:
            item.reaction_type || 'love',
          created_at: item.created_at,
          user: {
            id: user.id || item.user_id,
            name:
              user.name ||
              user.username ||
              'Reader',
            username: user.username || '',
            avatar_url: user.avatar_url || '',
          },
        }
      }
    )

    const total = Number(count || 0)

    return res.status(200).json({
      ok: true,
      post: {
        id: post.id,
        content: String(
          post.content || ''
        ).slice(0, 120),
      },
      total,
      counts,
      page,
      limit,
      has_more: to + 1 < total,
      reactions,
    })
  } catch (error) {
    console.error(
      'GET AUTHOR POST REACTIONS ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message: 'Failed to load post reactions',
      error: error.message,
    })
  }
}


function publicAuthorPostComment(
  comment,
  likedIds = new Set()
) {
  const isDeleted = Boolean(comment.deleted_at)
  const relatedUser = Array.isArray(comment.user)
    ? comment.user[0]
    : comment.user

  return {
    id: comment.id,
    post_id: comment.post_id,
    user_id: isDeleted ? null : comment.user_id,
    parent_id: comment.parent_id,
    text: isDeleted
      ? 'Comment deleted'
      : comment.text || '',
    is_deleted: isDeleted,
    is_hidden: isDeleted
      ? false
      : Boolean(comment.is_hidden),
    is_pinned: isDeleted
      ? false
      : Boolean(comment.is_pinned),
    likes: isDeleted
      ? 0
      : Number(comment.likes || 0),
    liked:
      !isDeleted &&
      likedIds.has(String(comment.id)),
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
      : relatedUser
        ? {
            id: relatedUser.id,
            name:
              relatedUser.name ||
              relatedUser.username ||
              'Reader',
            username:
              relatedUser.username || '',
            avatar_url:
              relatedUser.avatar_url || '',
            role:
              relatedUser.role || 'reader',
          }
        : {
            id: null,
            name: 'Reader',
            username: '',
            avatar_url: '',
            role: 'reader',
          },
    replies: Array.isArray(comment.replies)
      ? comment.replies.map((reply) =>
          publicAuthorPostComment(
            reply,
            likedIds
          )
        )
      : [],
  }
}

async function getVisibleAuthorPostCommentCount(postId) {
  const {
    data: visibleParents,
    error: parentError,
  } = await supabase
    .from('author_page_post_comments')
    .select('id, deleted_at')
    .eq('post_id', postId)
    .eq('is_hidden', false)
    .is('parent_id', null)

  if (parentError) throw parentError

  const parents = visibleParents || []

  const activeParentCount =
    parents.filter(
      (item) => !item.deleted_at
    ).length

  const parentIds = parents
    .map((item) => item.id)
    .filter(Boolean)

  let replyCount = 0

  if (parentIds.length) {
    const { count, error } = await supabase
      .from('author_page_post_comments')
      .select('id', {
        count: 'exact',
        head: true,
      })
      .eq('post_id', postId)
      .eq('is_hidden', false)
      .is('deleted_at', null)
      .in('parent_id', parentIds)

    if (error) throw error

    replyCount = Number(count || 0)
  }

  return activeParentCount + replyCount
}

export async function getAuthorPostCommentById(req, res) {
  try {
    const userId = getRequestUserId(req)
    const postId = String(req.params.postId || '').trim()
    const commentId = String(req.params.commentId || '').trim()

    if (!postId || !commentId) {
      return res.status(400).json({
        ok: false,
        message: 'Post ID and comment ID are required',
      })
    }

    const { data: post, error: postError } = await supabase
      .from('author_page_posts')
      .select('id, user_id, status')
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

    const isAuthorPageOwner = Boolean(
      userId &&
        post.user_id &&
        String(userId) === String(post.user_id)
    )

    let commentQuery = supabase
      .from('author_page_post_comments')
      .select('*, user:users(id, name, username, avatar_url, role)')
      .eq('id', commentId)
      .eq('post_id', postId)
      .is('deleted_at', null)

    if (!isAuthorPageOwner) {
      commentQuery = commentQuery.eq('is_hidden', false)
    }

    const { data: comment, error: commentError } =
      await commentQuery.maybeSingle()

    if (commentError) throw commentError

    if (!comment) {
      return res.status(404).json({
        ok: false,
        message: 'Comment not found',
      })
    }

    let parentComment = null
let parentReplyTotal = 0

if (comment.parent_id) {
  let parentQuery = supabase
    .from('author_page_post_comments')
    .select('*, user:users(id, name, username, avatar_url, role)')
    .eq('id', comment.parent_id)
    .eq('post_id', postId)

  if (!isAuthorPageOwner) {
    parentQuery = parentQuery.eq(
      'is_hidden',
      false
    )
  }

  const { data, error } =
    await parentQuery.maybeSingle()

  if (error) throw error

  if (!data && !isAuthorPageOwner) {
    return res.status(404).json({
      ok: false,
      message: 'Comment not found',
    })
  }

  parentComment = data || null

  if (parentComment) {
    let replyCountQuery = supabase
      .from('author_page_post_comments')
      .select('id', {
        count: 'exact',
        head: true,
      })
      .eq('post_id', postId)
      .eq(
        'parent_id',
        parentComment.id
      )
      .is('deleted_at', null)

    if (!isAuthorPageOwner) {
      replyCountQuery =
        replyCountQuery.eq(
          'is_hidden',
          false
        )
    }

    const {
      count,
      error: replyCountError,
    } = await replyCountQuery

    if (replyCountError) {
      throw replyCountError
    }

    parentReplyTotal =
      Number(count || 0)
  }
}

    const likedIds = await getAuthorPostCommentLikedIds(
      userId,
      [comment.id, parentComment?.id].filter(Boolean)
    )

    return res.status(200).json({
      ok: true,
      comment: publicAuthorPostComment(comment, likedIds),
      parent_comment: parentComment
  ? {
      ...publicAuthorPostComment(
        parentComment,
        likedIds
      ),
      reply_total: parentReplyTotal,
      reply_page: 0,
      reply_has_more:
        parentReplyTotal > 1,
    }
  : null,
    })
  } catch (error) {
    console.error('GET AUTHOR POST COMMENT BY ID ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load post comment',
      error: error.message,
    })
  }
}

export async function getAuthorPostComments(req, res) {
  try {
    const userId = getRequestUserId(req)
    const postId = String(req.params.postId || '').trim()
    const page = Math.max(1, Number(req.query.page || 1))
    const limit = Math.min(
      30,
      Math.max(1, Number(req.query.limit || 10))
    )
    const replyLimit = Math.min(
      30,
      Math.max(1, Number(req.query.reply_limit || 10))
    )
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
      .select('id, user_id, status')
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

    const isAuthorPageOwner = Boolean(
  userId &&
    post.user_id &&
    String(userId) === String(post.user_id)
)

let replyParentQuery = supabase
  .from('author_page_post_comments')
  .select('parent_id')
  .eq('post_id', postId)
  .not('parent_id', 'is', null)
  .is('deleted_at', null)

if (!isAuthorPageOwner) {
  replyParentQuery =
    replyParentQuery.eq(
      'is_hidden',
      false
    )
}

const {
  data: replyParentRows,
  error: replyParentError,
} = await replyParentQuery

if (replyParentError) {
  throw replyParentError
}

const replyParentIds = [
  ...new Set(
    (replyParentRows || [])
      .map((item) =>
        String(
          item.parent_id || ''
        ).trim()
      )
      .filter(Boolean)
  ),
]

let parentQuery = supabase
  .from('author_page_post_comments')
  .select(
    '*, user:users(id, name, username, avatar_url, role)',
    { count: 'exact' }
  )
  .eq('post_id', postId)
  .is('parent_id', null)

if (replyParentIds.length) {
  parentQuery = parentQuery.or(
    `deleted_at.is.null,id.in.(${replyParentIds.join(
      ','
    )})`
  )
} else {
  parentQuery =
    parentQuery.is(
      'deleted_at',
      null
    )
}

if (!isAuthorPageOwner) {
  parentQuery = parentQuery.eq(
    'is_hidden',
    false
  )
}

    const {
      data: parentComments,
      error: commentsError,
      count: parentCount,
    } = await parentQuery
      .order('is_pinned', { ascending: false })
      .order('created_at', { ascending: false })
      .range(from, to)

    if (commentsError) throw commentsError

    const parents = parentComments || []

    const replyGroups = await Promise.all(
      parents.map(async (parent) => {
        let replyQuery = supabase
          .from('author_page_post_comments')
          .select(
            '*, user:users(id, name, username, avatar_url, role)',
            { count: 'exact' }
          )
          .eq('post_id', postId)
          .eq('parent_id', parent.id)
          .is('deleted_at', null)

        if (!isAuthorPageOwner) {
          replyQuery = replyQuery.eq('is_hidden', false)
        }

        const {
          data: replyRows,
          error: repliesError,
          count: replyCount,
        } = await replyQuery
          .order('created_at', { ascending: true })
          .range(0, replyLimit - 1)

        if (repliesError) throw repliesError

        return {
          parentId: String(parent.id),
          replies: replyRows || [],
          total: Number(replyCount || 0),
        }
      })
    )

    const repliesByParent = new Map(
      replyGroups.map((group) => [
        group.parentId,
        group,
      ])
    )

    const comments = parents.map((parent) => {
      const group =
        repliesByParent.get(String(parent.id)) || {
          replies: [],
          total: 0,
        }

      return {
        ...parent,
        replies: group.replies,
        reply_total: group.total,
        reply_page: 1,
        reply_has_more:
          group.replies.length < group.total,
      }
    })

    const commentIds = comments
      .flatMap((comment) => [
        comment.id,
        ...(comment.replies || []).map(
          (reply) => reply.id
        ),
      ])
      .filter(Boolean)

    const likedIds =
      await getAuthorPostCommentLikedIds(
        userId,
        commentIds
      )

    const visibleTotal =
      await getVisibleAuthorPostCommentCount(
        postId
      )

    const totalParents = Number(parentCount || 0)

    return res.status(200).json({
      ok: true,
      comments: comments.map((comment) => ({
        ...publicAuthorPostComment(
          comment,
          likedIds
        ),
        reply_total: Number(
          comment.reply_total || 0
        ),
        reply_page: Number(
          comment.reply_page || 1
        ),
        reply_has_more: Boolean(
          comment.reply_has_more
        ),
      })),
      total: visibleTotal,
      parent_total: totalParents,
      page,
      limit,
      reply_limit: replyLimit,
      has_more: to + 1 < totalParents,
    })
  } catch (error) {
    console.error(
      'GET AUTHOR POST COMMENTS ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message: 'Failed to load post comments',
      error: error.message,
    })
  }
}

export async function getAuthorPostCommentReplies(
  req,
  res
) {
  try {
    const userId = getRequestUserId(req)
    const postId = String(
      req.params.postId || ''
    ).trim()
    const commentId = String(
      req.params.commentId || ''
    ).trim()
    const page = Math.max(
      1,
      Number(req.query.page || 1)
    )
    const limit = Math.min(
      30,
      Math.max(1, Number(req.query.limit || 10))
    )
    const from = (page - 1) * limit
    const to = from + limit - 1

    if (!postId || !commentId) {
      return res.status(400).json({
        ok: false,
        message:
          'Post ID and comment ID are required',
      })
    }

    const { data: post, error: postError } =
      await supabase
        .from('author_page_posts')
        .select('id, user_id, status')
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

    const isAuthorPageOwner = Boolean(
      userId &&
        post.user_id &&
        String(userId) === String(post.user_id)
    )

    let parentQuery = supabase
      .from('author_page_post_comments')
      .select('id, post_id, parent_id, is_hidden')
      .eq('id', commentId)
      .eq('post_id', postId)
      .is('parent_id', null)

    if (!isAuthorPageOwner) {
      parentQuery = parentQuery.eq('is_hidden', false)
    }

    const {
      data: parentComment,
      error: parentError,
    } = await parentQuery.maybeSingle()

    if (parentError) throw parentError

    if (!parentComment) {
      return res.status(404).json({
        ok: false,
        message: 'Parent comment not found',
      })
    }

    let repliesQuery = supabase
      .from('author_page_post_comments')
      .select(
        '*, user:users(id, name, username, avatar_url, role)',
        { count: 'exact' }
      )
      .eq('post_id', postId)
      .eq('parent_id', commentId)
      .is('deleted_at', null)

    if (!isAuthorPageOwner) {
      repliesQuery = repliesQuery.eq('is_hidden', false)
    }

    const {
      data: replies,
      error: repliesError,
      count,
    } = await repliesQuery
      .order('created_at', { ascending: true })
      .range(from, to)

    if (repliesError) throw repliesError

    const replyRows = replies || []
    const likedIds =
      await getAuthorPostCommentLikedIds(
        userId,
        replyRows
          .map((reply) => reply.id)
          .filter(Boolean)
      )
    const total = Number(count || 0)

    return res.status(200).json({
      ok: true,
      replies: replyRows.map((reply) =>
        publicAuthorPostComment(
          reply,
          likedIds
        )
      ),
      total,
      page,
      limit,
      has_more: to + 1 < total,
    })
  } catch (error) {
    console.error(
      'GET AUTHOR POST COMMENT REPLIES ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message: 'Failed to load comment replies',
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

    const authorReaderBlock =
      await getActiveAuthorReaderBlock({
        authorPageId:
          post.author_page_id,
        authorUserId:
          post.user_id,
        storyId: null,
        readerUserId:
          userId,
      })

    if (authorReaderBlock) {
      res.setHeader(
        'Retry-After',
        String(
          authorReaderBlock
            .retry_after_seconds
        )
      )

      return res.status(403).json(
        authorReaderBlockedPayload(
          authorReaderBlock
        )
      )
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

    const nextCommentCount =
      await getVisibleAuthorPostCommentCount(
        postId
      )

    const { error: updatePostError } = await supabase
      .from('author_page_posts')
      .update({
        comment_count: nextCommentCount,
        updated_at: new Date().toISOString(),
      })
      .eq('id', postId)

    if (updatePostError) throw updatePostError

    const reader = Array.isArray(createdComment.user)
      ? createdComment.user[0]
      : createdComment.user
    const readerName =
      reader?.name || reader?.username || 'A reader'

    const notificationPayload = {
      authorPageId: post.author_page_id,
      authorUserId: post.user_id,
      type: 'comment',
      title: `${readerName} ${parentId ? 'replied to' : 'commented on'} your post`,
      message: text,
      targetUrl: `/author/page?post=${postId}`,
      sourceKey: `author-post-comment:${createdComment.id}`,
      metadata: {
        post_id: postId,
        comment_id: createdComment.id,
        parent_id: parentId,
        reader_id: userId,
        reader_name: readerName,
        reader_username: reader?.username || '',
        reader_avatar_url: reader?.avatar_url || '',
      },
    }

    const isOwner = String(post.user_id || '') === String(userId)

    if (!isOwner && post.author_page_id) {
      await Promise.all([
        incrementAuthorPageAnalytics(post.author_page_id, 'comments'),
        incrementAuthorPageAnalytics(post.author_page_id, 'interactions'),
        createAuthorPageNotificationSafely(notificationPayload),
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

export async function setAuthorPostCommentHidden(
  req,
  res
) {
  try {
    const userId = req.user?.user_id
    const commentId = String(
      req.params.commentId || ''
    ).trim()

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

    if (
      typeof req.body?.is_hidden !==
      'boolean'
    ) {
      return res.status(400).json({
        ok: false,
        message: 'is_hidden must be boolean',
      })
    }

    const isHidden = req.body.is_hidden

    const {
      data: existingComment,
      error: commentError,
    } = await supabase
      .from('author_page_post_comments')
      .select(
        'id, post_id, user_id, parent_id, is_hidden'
      )
      .eq('id', commentId)
      .is('deleted_at', null)
      .maybeSingle()

    if (commentError) throw commentError

    if (!existingComment) {
      return res.status(404).json({
        ok: false,
        message: 'Comment not found',
      })
    }

    const { data: post, error: postError } =
      await supabase
        .from('author_page_posts')
        .select(
          'id, author_page_id, user_id, status'
        )
        .eq('id', existingComment.post_id)
        .eq('status', 'active')
        .maybeSingle()

    if (postError) throw postError

    if (!post) {
      return res.status(404).json({
        ok: false,
        message: 'Author Page post not found',
      })
    }

    const ownsAuthorPage =
      String(post.user_id || '') ===
      String(userId)

    if (!ownsAuthorPage) {
      return res.status(403).json({
        ok: false,
        message:
          'Only this Page can hide or unhide comments',
      })
    }

    const {
      data: updatedComment,
      error: updateError,
    } = await supabase
      .from('author_page_post_comments')
      .update({
        is_hidden: isHidden,
        updated_at: new Date().toISOString(),
      })
      .eq('id', commentId)
      .is('deleted_at', null)
      .select(
        '*, user:users(id, name, username, avatar_url, role)'
      )
      .single()

    if (updateError) throw updateError

    const nextCommentCount =
      await getVisibleAuthorPostCommentCount(
        post.id
      )

    const { error: updatePostError } =
      await supabase
        .from('author_page_posts')
        .update({
          comment_count: nextCommentCount,
          updated_at:
            new Date().toISOString(),
        })
        .eq('id', post.id)

    if (updatePostError) {
      throw updatePostError
    }

    return res.status(200).json({
      ok: true,
      message: isHidden
        ? 'Comment hidden by this Page'
        : 'Comment unhidden by this Page',
      comment:
        publicAuthorPostComment(
          updatedComment
        ),
      comment_count: nextCommentCount,
    })
  } catch (error) {
    console.error(
      'SET AUTHOR POST COMMENT HIDDEN ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to update comment visibility',
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

export async function toggleAuthorPostCommentLike(
  req,
  res
) {
  try {
    const userId = req.user?.user_id
    const commentId = String(
      req.params.commentId || ''
    ).trim()

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

    const { data: comment, error: commentError } =
      await supabase
        .from('author_page_post_comments')
        .select(
          'id, post_id, user_id, text, deleted_at'
        )
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

    const { data: post, error: postError } =
      await supabase
        .from('author_page_posts')
        .select(
          'id, author_page_id, user_id, status'
        )
        .eq('id', comment.post_id)
        .eq('status', 'active')
        .maybeSingle()

    if (postError) throw postError

    if (!post) {
      return res.status(404).json({
        ok: false,
        message: 'Author Page post not found',
      })
    }

    const {
      data: existingLike,
      error: lookupError,
    } = await supabase
      .from('author_page_post_comment_likes')
      .select('id')
      .eq('comment_id', commentId)
      .eq('user_id', userId)
      .maybeSingle()

    if (lookupError) throw lookupError

    let liked = false

    if (existingLike?.id) {
      const { error: deleteError } =
        await supabase
          .from(
            'author_page_post_comment_likes'
          )
          .delete()
          .eq('id', existingLike.id)

      if (deleteError) throw deleteError
    } else {
      const { error: insertError } =
        await supabase
          .from(
            'author_page_post_comment_likes'
          )
          .insert({
            comment_id: commentId,
            user_id: userId,
          })

      if (insertError) throw insertError
      liked = true
    }

    const { count, error: countError } =
      await supabase
        .from(
          'author_page_post_comment_likes'
        )
        .select('id', {
          count: 'exact',
          head: true,
        })
        .eq('comment_id', commentId)

    if (countError) throw countError

    const likes = Number(count || 0)

    const { error: updateCommentError } =
      await supabase
        .from('author_page_post_comments')
        .update({
          likes,
          updated_at:
            new Date().toISOString(),
        })
        .eq('id', commentId)

    if (updateCommentError) {
      throw updateCommentError
    }

    const commentBelongsToAuthor =
      String(comment.user_id || '') ===
      String(post.user_id || '')
    const isSelfLike =
      String(comment.user_id || '') ===
      String(userId)
    const sourceKey =
      `author-post-comment-like:${commentId}:${userId}`

    if (
      commentBelongsToAuthor &&
      !isSelfLike &&
      post.author_page_id
    ) {
      if (!liked) {
        await deleteAuthorPageNotificationBySourceKeySafely({
          authorPageId:
            post.author_page_id,
          type: 'reaction',
          sourceKey,
        })
      } else {
        const {
          data: reader,
          error: readerError,
        } = await supabase
          .from('users')
          .select(
            'id, name, username, avatar_url'
          )
          .eq('id', userId)
          .maybeSingle()

        if (readerError) throw readerError

        const readerName =
          reader?.name ||
          reader?.username ||
          'A reader'

        await createAuthorPageNotificationSafely({
          authorPageId:
            post.author_page_id,
          authorUserId: post.user_id,
          type: 'reaction',
          title:
            `${readerName} liked your comment`,
          message: String(
            comment.text || ''
          ).slice(0, 160),
          targetUrl:
            `/author/page?post=${post.id}`,
          sourceKey,
          metadata: {
            post_id: post.id,
            comment_id: commentId,
            reaction_type:
              'comment_like',
            reader_id: userId,
            reader_name: readerName,
            reader_username:
              reader?.username || '',
            reader_avatar_url:
              reader?.avatar_url || '',
          },
        })
      }
    }

    return res.status(200).json({
      ok: true,
      liked,
      likes,
    })
  } catch (error) {
    console.error(
      'TOGGLE AUTHOR POST COMMENT LIKE ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to update comment like',
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
      .select('id, author_page_id, user_id')
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

    await deleteAuthorPageNotificationBySourceKeySafely({
      authorPageId: post.author_page_id,
      type: 'comment',
      sourceKey: `author-post-comment:${commentId}`,
    })

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

