import { supabase } from '../config/supabase.js'

const NOTIFICATION_RETENTION_DAYS = 90

async function cleanupOldNotifications(userId) {
  if (!userId) return

  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - NOTIFICATION_RETENTION_DAYS)

  const { error } = await supabase
    .from('notifications')
    .delete()
    .eq('user_id', userId)
    .lt('created_at', cutoffDate.toISOString())

  if (error) {
    console.error('CLEANUP OLD NOTIFICATIONS ERROR:', error)
  }
}

function normalizeType(value) {
  const type = String(value || '').trim().toLowerCase()
  return ['community', 'announcements'].includes(type) ? type : 'announcements'
}

function publicNotification(item) {
  return {
    id: item.id,
    user_id: item.user_id,
    type: item.type,
    title: item.title,
    message: item.message,
    image_url: item.image_url || '',
    link: item.link || '',
    reference_id: item.reference_id || '',
    is_read: Boolean(item.is_read),
    created_at: item.created_at,
    read_at: item.read_at || null,
  }
}

function buildCounts(items) {
  return {
    all: items.length,
    unread: items.filter((item) => !item.is_read).length,
    community: items.filter((item) => item.type === 'community' && !item.is_read).length,
    announcements: items.filter((item) => item.type === 'announcements' && !item.is_read).length,
  }
}

export async function getMyNotifications(req, res) {
  try {
    const userId = req.user?.user_id
    const type = String(req.query.type || 'all').trim().toLowerCase()

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    await cleanupOldNotifications(userId)

    let query = supabase
      .from('notifications')
      .select('id, user_id, type, title, message, image_url, link, reference_id, is_read, created_at, read_at')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(80)

    if (type === 'unread') {
      query = query.eq('is_read', false)
    } else if (['community', 'announcements'].includes(type)) {
      query = query.eq('type', type)
    }

    const { data, error } = await query

    if (error) throw error

    const { data: countRows, error: countError } = await supabase
      .from('notifications')
      .select('id, type, is_read')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .limit(500)

    if (countError) throw countError

    return res.status(200).json({
      ok: true,
      notifications: (data || []).map(publicNotification),
      counts: buildCounts(countRows || []),
    })
  } catch (error) {
    console.error('GET MY NOTIFICATIONS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load notifications',
      error: error.message,
    })
  }
}

export async function getMyNotificationUnreadCount(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    await cleanupOldNotifications(userId)

    const { count, error } = await supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('is_read', false)
      .is('deleted_at', null)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      unread_count: Number(count || 0),
    })
  } catch (error) {
    console.error('GET NOTIFICATION UNREAD COUNT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load notification count',
      error: error.message,
    })
  }
}

export async function markNotificationAsRead(req, res) {
  try {
    const userId = req.user?.user_id
    const notificationId = String(req.params.notificationId || '').trim()

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!notificationId) {
      return res.status(400).json({ ok: false, message: 'Notification ID is required' })
    }

    const { data, error } = await supabase
      .from('notifications')
      .update({
        is_read: true,
        read_at: new Date().toISOString(),
      })
      .eq('id', notificationId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .select('id, user_id, type, title, message, image_url, link, reference_id, is_read, created_at, read_at')
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({ ok: false, message: 'Notification not found' })
    }

    return res.status(200).json({
      ok: true,
      notification: publicNotification(data),
    })
  } catch (error) {
    console.error('MARK NOTIFICATION READ ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to mark notification as read',
      error: error.message,
    })
  }
}

export async function markAllNotificationsAsRead(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const { error } = await supabase
      .from('notifications')
      .update({
        is_read: true,
        read_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('is_read', false)
      .is('deleted_at', null)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'All notifications marked as read',
    })
  } catch (error) {
    console.error('MARK ALL NOTIFICATIONS READ ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to mark notifications as read',
      error: error.message,
    })
  }
}

export async function createNotification({ userId, type, title, message, imageUrl = '', link = '', referenceId = '' }) {
  if (!userId || !title || !message) return null

  const { data, error } = await supabase
    .from('notifications')
    .insert({
      user_id: userId,
      type: normalizeType(type),
      title: String(title || '').trim(),
      message: String(message || '').trim(),
      image_url: String(imageUrl || '').trim(),
      link: String(link || '').trim(),
      reference_id: String(referenceId || '').trim(),
      is_read: false,
    })
    .select('id, user_id, type, title, message, image_url, link, reference_id, is_read, created_at, read_at')
    .single()

  if (error) {
    console.error('CREATE NOTIFICATION ERROR:', error)
    return null
  }

  return publicNotification(data)
}
