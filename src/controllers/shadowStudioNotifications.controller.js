import { supabase } from '../config/supabase.js'

const MAX_PAGE_SIZE = 30
const FIELDS = 'id,type,title,message,target_url,is_read,metadata,created_at,read_at'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function activeAuthorPage(userId) {
  const { data, error } = await supabase.from('author_pages')
    .select('id').eq('user_id', userId).eq('status', 'active').maybeSingle()
  if (error) throw error
  return data
}

function notificationQuery(authorPageId, userId) {
  return supabase.from('author_page_notifications')
    .select(FIELDS)
    .eq('author_page_id', authorPageId)
    .eq('user_id', userId)
    .contains('metadata', { source: 'fast_reel' })
}

function parseCursor(value) {
  if (!value) return null
  const parts = String(value).split('|')
  if (parts.length !== 2 || !UUID.test(parts[1]) || Number.isNaN(Date.parse(parts[0]))) return false
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(parts[0])) return false
  return { at: parts[0], id: parts[1] }
}

export async function listStudioVideoNotifications(req, res) {
  const userId = req.user?.user_id
  if (!userId) return res.status(401).json({ ok: false, message: 'Unauthorized' })
  const cursor = parseCursor(req.query.before)
  if (cursor === false) return res.status(400).json({ ok: false, message: 'Invalid notification cursor' })
  const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(Number(req.query.limit) || 10)))
  const unreadOnly = String(req.query.unread || '').toLowerCase() === 'true'
  try {
    const page = await activeAuthorPage(userId)
    if (!page) return res.status(404).json({ ok: false, message: 'Author page not found' })
    let query = notificationQuery(page.id, userId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1)
    if (unreadOnly) query = query.eq('is_read', false)
    if (cursor) query = query.or(`created_at.lt.${cursor.at},and(created_at.eq.${cursor.at},id.lt.${cursor.id})`)
    const { data, error } = await query
    if (error) throw error
    const notifications = (data || []).slice(0, limit)
    const last = notifications[notifications.length - 1]
    res.setHeader('Cache-Control', 'private, no-store')
    return res.json({
      ok: true,
      notifications,
      has_more: (data || []).length > limit,
      next_cursor: (data || []).length > limit && last ? `${last.created_at}|${last.id}` : null,
    })
  } catch (error) {
    console.error('STUDIO_VIDEO_NOTIFICATIONS_LIST_ERROR', { code: error?.code, message: error?.message })
    return res.status(500).json({ ok: false, message: 'Unable to load Studio notifications' })
  }
}

export async function countStudioVideoUnreadNotifications(req, res) {
  const userId = req.user?.user_id
  if (!userId) return res.status(401).json({ ok: false, message: 'Unauthorized' })
  try {
    const page = await activeAuthorPage(userId)
    if (!page) return res.status(404).json({ ok: false, message: 'Author page not found' })
    const { count, error } = await supabase.from('author_page_notifications')
      .select('id', { head: true, count: 'exact' })
      .eq('author_page_id', page.id)
      .eq('user_id', userId)
      .eq('is_read', false)
      .contains('metadata', { source: 'fast_reel' })
    if (error) throw error
    res.setHeader('Cache-Control', 'private, no-store')
    return res.json({ ok: true, unread_count: Math.max(0, Number(count || 0)) })
  } catch (error) {
    console.error('STUDIO_VIDEO_NOTIFICATIONS_COUNT_ERROR', { code: error?.code, message: error?.message })
    return res.status(500).json({ ok: false, message: 'Unable to load Studio unread count' })
  }
}
