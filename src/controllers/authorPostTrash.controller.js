import { supabase } from '../config/supabase.js'
import {
  invalidateDiscoverAuthorPostsSharedCache,
} from '../services/discoverAuthorPostsSharedCache.service.js'

const AUTHOR_POST_TRASH_DAYS = 30
const ADMIN_ARCHIVE_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

function getUserId(req) {
  return String(req.user?.user_id || req.user?.id || '').trim()
}

function normalizeImageUrls(value) {
  if (!Array.isArray(value)) return []

  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 5)
}

function getDaysLeft(value) {
  if (!value) return 0

  const expiresAt = new Date(value).getTime()
  if (!Number.isFinite(expiresAt)) return 0

  return Math.max(
    0,
    Math.ceil((expiresAt - Date.now()) / DAY_MS)
  )
}

function publicTrashPost(post) {
  return {
    id: post.id,
    author_page_id: post.author_page_id,
    user_id: post.user_id,
    post_type: post.post_type || 'article',
    content: post.content || '',
    image_urls: normalizeImageUrls(post.image_urls),
    status: post.status,
    is_pinned: Boolean(post.is_pinned),
    like_count: Number(post.like_count || 0),
    comment_count: Number(post.comment_count || 0),
    echo_count: Number(post.echo_count || 0),
    created_at: post.created_at,
    updated_at: post.updated_at,
    deleted_at: post.deleted_at,
    delete_expires_at: post.delete_expires_at,
    admin_archive_expires_at: post.admin_archive_expires_at,
    days_left: getDaysLeft(post.delete_expires_at),
  }
}

async function getMyActiveAuthorPage(userId) {
  const { data, error } = await supabase
    .from('author_pages')
    .select('id, user_id')
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle()

  if (error) throw error
  return data || null
}

export async function getMyAuthorPostTrash(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const authorPage = await getMyActiveAuthorPage(userId)

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message: 'Author page not found',
      })
    }

    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('author_page_posts')
      .select('*')
      .eq('author_page_id', authorPage.id)
      .eq('user_id', userId)
      .eq('status', 'deleted')
      .gt('delete_expires_at', now)
      .order('deleted_at', { ascending: false })
      .limit(100)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      posts: (data || []).map(publicTrashPost),
    })
  } catch (error) {
    console.error('GET MY AUTHOR POST TRASH ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load post trash',
      error: error.message,
    })
  }
}

export async function moveMyAuthorPostToTrash(req, res) {
  try {
    const userId = getUserId(req)
    const postId = String(req.params.postId || '').trim()

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

    const authorPage = await getMyActiveAuthorPage(userId)

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message: 'Author page not found',
      })
    }

    const deletedAt = new Date()
    const deleteExpiresAt = new Date(
      deletedAt.getTime() + AUTHOR_POST_TRASH_DAYS * DAY_MS
    )
    const adminArchiveExpiresAt = new Date(
      deleteExpiresAt.getTime() + ADMIN_ARCHIVE_DAYS * DAY_MS
    )

    const { data, error } = await supabase
      .from('author_page_posts')
      .update({
        status: 'deleted',
        is_pinned: false,
        deleted_at: deletedAt.toISOString(),
        delete_expires_at: deleteExpiresAt.toISOString(),
        admin_archive_expires_at:
          adminArchiveExpiresAt.toISOString(),
        updated_at: deletedAt.toISOString(),
      })
      .eq('id', postId)
      .eq('author_page_id', authorPage.id)
      .eq('user_id', userId)
      .eq('status', 'active')
      .select()
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({
        ok: false,
        message: 'Active post not found',
      })
    }

    invalidateDiscoverAuthorPostsSharedCache()

    return res.status(200).json({
      ok: true,
      message: 'Post moved to trash',
      post: publicTrashPost(data),
    })
  } catch (error) {
    console.error('MOVE AUTHOR POST TO TRASH ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to move post to trash',
      error: error.message,
    })
  }
}

export async function restoreMyAuthorPostFromTrash(req, res) {
  try {
    const userId = getUserId(req)
    const postId = String(req.params.postId || '').trim()

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

    const authorPage = await getMyActiveAuthorPage(userId)

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message: 'Author page not found',
      })
    }

    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('author_page_posts')
      .update({
        status: 'active',
        deleted_at: null,
        delete_expires_at: null,
        admin_archive_expires_at: null,
        updated_at: now,
      })
      .eq('id', postId)
      .eq('author_page_id', authorPage.id)
      .eq('user_id', userId)
      .eq('status', 'deleted')
      .gt('delete_expires_at', now)
      .select()
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({
        ok: false,
        message: 'Post not found or recovery expired',
      })
    }

    invalidateDiscoverAuthorPostsSharedCache()

    return res.status(200).json({
      ok: true,
      message: 'Post restored successfully',
      post: {
        ...publicTrashPost(data),
        status: 'active',
        deleted_at: null,
        delete_expires_at: null,
        admin_archive_expires_at: null,
        days_left: 0,
      },
    })
  } catch (error) {
    console.error('RESTORE AUTHOR POST FROM TRASH ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to restore post',
      error: error.message,
    })
  }
}
