import { supabase } from '../config/supabase.js'

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

const NOTIFICATION_RETENTION_DAYS = 90
const NOTIFICATION_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const notificationCleanupTimestamps = new Map()
const DEFAULT_NOTIFICATION_PAGE_SIZE = 30
const MAX_NOTIFICATION_PAGE_SIZE = 100
const NOTIFICATION_SELECT =
  'id, user_id, type, title, message, image_url, link, reference_id, is_read, created_at, read_at'

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

async function maybeCleanupOldNotifications(userId) {
  if (!userId) return

  const key = String(userId)
  const now = Date.now()
  const lastCleanup = Number(notificationCleanupTimestamps.get(key) || 0)

  if (now - lastCleanup < NOTIFICATION_CLEANUP_INTERVAL_MS) {
    return
  }

  notificationCleanupTimestamps.set(key, now)

  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - NOTIFICATION_RETENTION_DAYS)

  const { error } = await supabase
    .from('notifications')
    .delete()
    .eq('user_id', userId)
    .lt('created_at', cutoffDate.toISOString())

  if (error) {
    notificationCleanupTimestamps.delete(key)
    console.error('CLEANUP OLD NOTIFICATIONS ERROR:', error)
  }
}

async function countNotifications(userId, { type = '', unreadOnly = false } = {}) {
  let query = supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .is('deleted_at', null)

  if (unreadOnly) {
    query = query.eq('is_read', false)
  }

  if (type) {
    query = query.eq('type', type)
  }

  const { count, error } = await query

  if (error) throw error

  return Number(count || 0)
}

async function getNotificationCounts(userId) {
  const [all, unread, community, announcements] = await Promise.all([
    countNotifications(userId),
    countNotifications(userId, { unreadOnly: true }),
    countNotifications(userId, { type: 'community', unreadOnly: true }),
    countNotifications(userId, { type: 'announcements', unreadOnly: true }),
  ])

  return {
    all,
    unread,
    community,
    announcements,
  }
}

export async function getMyNotifications(req, res) {
  try {
    const userId = req.user?.user_id
    const requestedType = String(req.query.type || 'all').trim().toLowerCase()
    const type = ['all', 'unread', 'community', 'announcements'].includes(requestedType)
      ? requestedType
      : 'all'
    const page = parsePositiveInteger(req.query.page, 1)
    const requestedLimit = parsePositiveInteger(
      req.query.limit,
      DEFAULT_NOTIFICATION_PAGE_SIZE
    )
    const limit = Math.min(requestedLimit, MAX_NOTIFICATION_PAGE_SIZE)
    const includeCounts = String(req.query.include_counts ?? '1') !== '0'
    const from = (page - 1) * limit
    const to = from + limit - 1

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    let query = supabase
      .from('notifications')
      .select(NOTIFICATION_SELECT, { count: 'exact' })
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .range(from, to)

    if (type === 'unread') {
      query = query.eq('is_read', false)
    } else if (type === 'community' || type === 'announcements') {
      query = query.eq('type', type)
    }

    const { data, error, count } = await query

    if (error) throw error

    const counts = includeCounts
      ? await getNotificationCounts(userId)
      : undefined
    const total = Number(count || 0)

    return res.status(200).json({
      ok: true,
      notifications: (data || []).map(publicNotification),
      ...(counts ? { counts } : {}),
      page,
      limit,
      total,
      has_more: page * limit < total,
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
      .select(NOTIFICATION_SELECT)
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
    .select(NOTIFICATION_SELECT)
    .single()

  if (error) {
    console.error('CREATE NOTIFICATION ERROR:', error)
    return null
  }

  await maybeCleanupOldNotifications(userId)

  return publicNotification(data)
}
