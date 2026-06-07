import { supabase } from '../config/supabase.js'

function normalizeNotification(item) {
  if (!item) return null

  return {
    id: item.id,
    author_page_id: item.author_page_id,
    user_id: item.user_id,
    type: item.type || 'system',
    title: item.title || '',
    message: item.message || '',
    target_url: item.target_url || '',
    is_read: Boolean(item.is_read),
    metadata: item.metadata || {},
    created_at: item.created_at,
    read_at: item.read_at || null,
  }
}

async function getMyAuthorPageByUserId(userId) {
  const { data, error } = await supabase
    .from('author_pages')
    .select('id, user_id')
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle()

  if (error) throw error

  return data || null
}

export async function createAuthorPageNotification({
  authorPageId,
  userId,
  type = 'system',
  title,
  message = '',
  targetUrl = '',
  metadata = {},
}) {
  if (!authorPageId || !userId || !title) return null

  const { data, error } = await supabase
    .from('author_page_notifications')
    .insert({
      author_page_id: authorPageId,
      user_id: userId,
      type,
      title,
      message,
      target_url: targetUrl,
      metadata,
      is_read: false,
    })
    .select()
    .single()

  if (error) throw error

  return normalizeNotification(data)
}

export async function getMyAuthorPageNotifications(req, res) {
  try {
    const userId = req.user?.user_id
    const limit = Math.min(50, Math.max(1, Number(req.query.limit || 30)))
    const type = String(req.query.type || 'all').trim().toLowerCase()
    const unreadOnly = String(req.query.unread || '').toLowerCase() === 'true'

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const authorPage = await getMyAuthorPageByUserId(userId)

    if (!authorPage) {
      return res.status(404).json({ ok: false, message: 'Author page not found' })
    }

    let query = supabase
      .from('author_page_notifications')
      .select('*')
      .eq('author_page_id', authorPage.id)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (type !== 'all') {
      query = query.eq('type', type)
    }

    if (unreadOnly) {
      query = query.eq('is_read', false)
    }

    const { data, error } = await query

    if (error) throw error

    const { count: unreadCount, error: countError } = await supabase
      .from('author_page_notifications')
      .select('id', { count: 'exact', head: true })
      .eq('author_page_id', authorPage.id)
      .eq('is_read', false)

    if (countError) throw countError

    return res.status(200).json({
      ok: true,
      notifications: (data || []).map(normalizeNotification),
      unread_count: Number(unreadCount || 0),
    })
  } catch (error) {
    console.error('GET AUTHOR PAGE NOTIFICATIONS ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load page notifications',
      error: error.message,
    })
  }
}

export async function markMyAuthorPageNotificationRead(req, res) {
  try {
    const userId = req.user?.user_id
    const notificationId = String(req.params.id || '').trim()

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!notificationId) {
      return res.status(400).json({ ok: false, message: 'Notification ID is required' })
    }

    const authorPage = await getMyAuthorPageByUserId(userId)

    if (!authorPage) {
      return res.status(404).json({ ok: false, message: 'Author page not found' })
    }

    const { data, error } = await supabase
      .from('author_page_notifications')
      .update({
        is_read: true,
        read_at: new Date().toISOString(),
      })
      .eq('id', notificationId)
      .eq('author_page_id', authorPage.id)
      .select()
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({ ok: false, message: 'Notification not found' })
    }

    return res.status(200).json({
      ok: true,
      notification: normalizeNotification(data),
    })
  } catch (error) {
    console.error('MARK AUTHOR PAGE NOTIFICATION READ ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to mark notification as read',
      error: error.message,
    })
  }
}

export async function markAllMyAuthorPageNotificationsRead(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const authorPage = await getMyAuthorPageByUserId(userId)

    if (!authorPage) {
      return res.status(404).json({ ok: false, message: 'Author page not found' })
    }

    const { error } = await supabase
      .from('author_page_notifications')
      .update({
        is_read: true,
        read_at: new Date().toISOString(),
      })
      .eq('author_page_id', authorPage.id)
      .eq('is_read', false)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Notifications marked as read',
    })
  } catch (error) {
    console.error('MARK ALL AUTHOR PAGE NOTIFICATIONS READ ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to mark all notifications as read',
      error: error.message,
    })
  }
}
