import { supabase } from '../config/supabase.js'

function normalizeNotification(item) {
  return {
    id: item.id,
    author_id: item.author_id,
    type: item.type || 'system',
    title: item.title || '',
    message: item.message || '',
    target_url: item.target_url || '',
    metadata: item.metadata || {},
    is_read: Boolean(item.is_read),
    read_at: item.read_at || null,
    created_at: item.created_at,
  }
}

async function getAuthorPage(userId) {
  const { data, error } = await supabase
    .from('author_pages')
    .select('id, user_id')
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle()

  if (error) throw error
  return data || null
}

export async function getMyAuthorStoryNotifications(req, res) {
  try {
    const userId = req.user?.user_id
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)))
    const type = String(req.query.type || 'all').trim().toLowerCase()
    const unreadOnly = String(req.query.unread || '').toLowerCase() === 'true'

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const authorPage = await getAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Author access is required' })
    }

    let query = supabase
      .from('author_story_notifications')
      .select('*')
      .eq('author_id', authorPage.id)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (type !== 'all') query = query.eq('type', type)
    if (unreadOnly) query = query.eq('is_read', false)

    const { data, error } = await query

    if (error) throw error

    const { count, error: countError } = await supabase
      .from('author_story_notifications')
      .select('id', { count: 'exact', head: true })
      .eq('author_id', authorPage.id)
      .eq('is_read', false)

    if (countError) throw countError

    return res.status(200).json({
      ok: true,
      notifications: (data || []).map(normalizeNotification),
      unread_count: Number(count || 0),
    })
  } catch (error) {
    console.error('GET AUTHOR STORY NOTIFICATIONS ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load story notifications',
      error: error.message,
    })
  }
}

export async function markMyAuthorStoryNotificationRead(req, res) {
  try {
    const userId = req.user?.user_id
    const notificationId = String(req.params.id || '').trim()

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!notificationId) {
      return res.status(400).json({ ok: false, message: 'Notification ID is required' })
    }

    const authorPage = await getAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Author access is required' })
    }

    const { data, error } = await supabase
      .from('author_story_notifications')
      .update({
        is_read: true,
        read_at: new Date().toISOString(),
      })
      .eq('id', notificationId)
      .eq('author_id', authorPage.id)
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
    console.error('MARK AUTHOR STORY NOTIFICATION READ ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to mark notification as read',
      error: error.message,
    })
  }
}

export async function markAllMyAuthorStoryNotificationsRead(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const authorPage = await getAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Author access is required' })
    }

    const { error } = await supabase
      .from('author_story_notifications')
      .update({
        is_read: true,
        read_at: new Date().toISOString(),
      })
      .eq('author_id', authorPage.id)
      .eq('is_read', false)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Story notifications marked as read',
    })
  } catch (error) {
    console.error('MARK ALL AUTHOR STORY NOTIFICATIONS READ ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to mark notifications as read',
      error: error.message,
    })
  }
}
