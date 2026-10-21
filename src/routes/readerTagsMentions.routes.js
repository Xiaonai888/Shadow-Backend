import express from 'express'
import { supabase } from '../config/supabase.js'
import { requireUser } from '../middleware/user.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import { getReaderTagsMentions, updateReaderTagsMentions } from '../controllers/readerTagsMentions.controller.js'
import { getPendingReaderTags, reviewPendingReaderTags } from '../controllers/readerTagReview.controller.js'

const router = express.Router()
const limitSettingsUpdates = createRateLimit({
  key: 'reader-tag-mention-settings',
  windowMs: 60000,
  max: 20,
  identity: (req) => req.user?.user_id || req.ip,
})
const limitTagReviews = createRateLimit({
  key: 'reader-tag-mention-reviews',
  windowMs: 60000,
  max: 20,
  identity: (req) => req.user?.user_id || req.ip,
})

async function getApprovedTaggedPosts(req, res) {
  res.set('Cache-Control', 'private, no-store')
  const userId = String(req.user?.user_id || req.user?.id || '').trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    return res.status(401).json({ ok: false, message: 'Please sign in again.' })
  }

  const pageNumber = Number(req.query?.page)
  const page = Number.isSafeInteger(pageNumber) && pageNumber >= 1 && pageNumber <= 10000 ? pageNumber : 1
  const limit = 20
  const offset = (page - 1) * limit

  try {
    const { data: links, count, error: linksError } = await supabase
      .from('reader_tag_mention_links')
      .select('post_id,created_at', { count: 'exact' })
      .eq('target_user_id', userId)
      .eq('kind', 'tag')
      .eq('status', 'approved')
      .not('post_id', 'is', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)
    if (linksError) throw linksError

    const ids = [...new Set((links || []).map((item) => item.post_id).filter(Boolean))]
    let posts = []

    if (ids.length) {
      const { data, error } = await supabase
        .from('reader_posts')
        .select('id,user_id,content,image_urls,created_at,publish_at,visibility')
        .in('id', ids)
        .eq('visibility', 'public')
        .is('deleted_at', null)
        .or(`publish_at.is.null,publish_at.lte.${new Date().toISOString()}`)
      if (error) throw error
      const byId = new Map((data || []).map((post) => [String(post.id), post]))
      posts = ids.map((id) => byId.get(String(id))).filter(Boolean)
    }

    const authorIds = [...new Set(posts.map((post) => post.user_id).filter(Boolean))]
    let readers = new Map()
    if (authorIds.length) {
      const { data, error } = await supabase
        .from('users')
        .select('id,name,username,avatar_url')
        .in('id', authorIds)
        .eq('is_active', true)
      if (error) throw error
      readers = new Map((data || []).map((reader) => [String(reader.id), reader]))
    }

    const visiblePosts = posts
      .filter((post) => readers.has(String(post.user_id)))
      .map((post) => ({
        id: post.id,
        user_id: post.user_id,
        content: String(post.content || '').slice(0, 500),
        image_url: Array.isArray(post.image_urls) ? post.image_urls.find((url) => typeof url === 'string' && url) || null : null,
        created_at: post.created_at,
        user: readers.get(String(post.user_id)),
      }))

    return res.status(200).json({
      ok: true,
      posts: visiblePosts,
      page,
      total: Number(count || 0),
      has_more: offset + limit < Number(count || 0),
    })
  } catch (error) {
    console.error('READER_APPROVED_TAGS_ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Unable to load tagged posts.' })
  }
}

router.get('/pending', requireUser, getPendingReaderTags)
router.get('/approved', requireUser, getApprovedTaggedPosts)
router.post('/review', requireUser, limitTagReviews, reviewPendingReaderTags)
router.get('/', requireUser, getReaderTagsMentions)
router.put('/', requireUser, limitSettingsUpdates, updateReaderTagsMentions)

export default router
