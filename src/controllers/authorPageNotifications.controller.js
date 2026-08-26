import { supabase } from '../config/supabase.js'
import {
  subscribeAuthorPageNotificationSse,
} from '../services/authorPageNotificationSse.service.js'

const NOTIFICATION_TYPES = new Set([
  'comment',
  'reaction',
  'echo',
  'mention',
  'follower',
  'review',
  'order',
  'income',
  'system',
  'admin',
])

const FREQUENCY_LEVELS = new Set([
  'more',
  'normal',
  'less',
])

const NOTIFICATION_PAGE_SIZE = 30
const RETENTION_DAYS = 30
const RETAIN_MINIMUM = 30
const CLEANUP_BATCH_SIZE = 1000

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

function normalizePreferences(rows = []) {
  const preferences = {}

  for (const row of rows) {
    preferences[row.type] = {
      is_enabled: row.is_enabled !== false,
      frequency_level:
        FREQUENCY_LEVELS.has(row.frequency_level)
          ? row.frequency_level
          : 'normal',
    }
  }

  return preferences
}

function parseBeforeCursor(value) {
  const cleanValue = String(
    value || ''
  ).trim()

  if (!cleanValue) return ''

  const parsed = new Date(cleanValue)

  if (Number.isNaN(parsed.getTime())) {
    return null
  }

  return parsed.toISOString()
}

async function cleanupOldAuthorPageNotifications(
  authorPageId
) {
  const cutoff = new Date(
    Date.now() -
      RETENTION_DAYS *
        24 *
        60 *
        60 *
        1000
  ).toISOString()

  const {
    data: newestRows,
    error: newestError,
  } = await supabase
    .from('author_page_notifications')
    .select('id')
    .eq(
      'author_page_id',
      authorPageId
    )
    .order('created_at', {
      ascending: false,
    })
    .limit(RETAIN_MINIMUM)

  if (newestError) throw newestError

  const keepIds = new Set(
    (newestRows || []).map((item) =>
      String(item.id)
    )
  )

  const {
    data: oldRows,
    error: oldRowsError,
  } = await supabase
    .from('author_page_notifications')
    .select('id')
    .eq(
      'author_page_id',
      authorPageId
    )
    .lt('created_at', cutoff)
    .order('created_at', {
      ascending: true,
    })
    .limit(CLEANUP_BATCH_SIZE)

  if (oldRowsError) {
    throw oldRowsError
  }

  const deleteIds = (oldRows || [])
    .map((item) => item.id)
    .filter(
      (id) =>
        !keepIds.has(String(id))
    )

  if (!deleteIds.length) return

  const { error: deleteError } =
    await supabase
      .from(
        'author_page_notifications'
      )
      .delete()
      .in('id', deleteIds)

  if (deleteError) throw deleteError
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

export function streamMyAuthorPageNotifications(
  req,
  res
) {
  const userId = req.user?.user_id

  if (!userId) {
    return res.status(401).json({
      ok: false,
      message: 'Unauthorized',
    })
  }

  res.status(200)
  res.setHeader(
    'Content-Type',
    'text/event-stream; charset=utf-8'
  )
  res.setHeader(
    'Cache-Control',
    'private, no-cache, no-transform'
  )
  res.setHeader(
    'Connection',
    'keep-alive'
  )
  res.setHeader(
    'X-Accel-Buffering',
    'no'
  )
  res.flushHeaders?.()
  res.write('retry: 5000\n\n')

  const unsubscribe =
    subscribeAuthorPageNotificationSse(
      userId,
      res
    )

  const close = () => {
    unsubscribe()
  }

  req.once('close', close)
  req.once('aborted', close)

  return undefined
}

export async function getMyAuthorPageNotificationUnreadCount(
  req,
  res
) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const authorPage =
      await getMyAuthorPageByUserId(userId)

    if (!authorPage) {
      res.setHeader(
        'Cache-Control',
        'private, no-store'
      )

      return res.status(200).json({
        ok: true,
        has_author_page: false,
        unread_count: 0,
      })
    }

    const { count, error } = await supabase
      .from('author_page_notifications')
      .select('id', {
        count: 'exact',
        head: true,
      })
      .eq('author_page_id', authorPage.id)
      .eq('user_id', userId)
      .eq('is_read', false)

    if (error) throw error

    res.setHeader(
      'Cache-Control',
      'private, no-store'
    )

    return res.status(200).json({
      ok: true,
      has_author_page: true,
      unread_count: Number(count || 0),
    })
  } catch (error) {
    console.error(
      'GET AUTHOR PAGE NOTIFICATION UNREAD COUNT ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to load notification unread count',
      error: error.message,
    })
  }
}

export async function getMyAuthorPageNotifications(
  req,
  res
) {
  try {
    const userId = req.user?.user_id
    const limit = Math.min(
      NOTIFICATION_PAGE_SIZE,
      Math.max(
        1,
        Number(
          req.query.limit ||
            NOTIFICATION_PAGE_SIZE
        )
      )
    )
    const type = String(
      req.query.type || 'all'
    )
      .trim()
      .toLowerCase()
    const unreadOnly =
      String(req.query.unread || '')
        .toLowerCase() === 'true'
    const before = parseBeforeCursor(
      req.query.before
    )

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (before === null) {
      return res.status(400).json({
        ok: false,
        message:
          'Notification cursor is not valid',
      })
    }

    const authorPage =
      await getMyAuthorPageByUserId(
        userId
      )

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message:
          'Author page not found',
      })
    }

    await cleanupOldAuthorPageNotifications(
      authorPage.id
    ).catch((error) => {
      console.error(
        'CLEANUP AUTHOR PAGE NOTIFICATIONS ERROR:',
        error
      )
    })

    let query = supabase
      .from(
        'author_page_notifications'
      )
      .select('*')
      .eq(
        'author_page_id',
        authorPage.id
      )
      .order('created_at', {
        ascending: false,
      })
      .limit(limit + 1)

    if (before) {
      query = query.lt(
        'created_at',
        before
      )
    }

    if (type !== 'all') {
      query = query.eq(
        'type',
        type
      )
    }

    if (unreadOnly) {
      query = query.eq(
        'is_read',
        false
      )
    }

    const [
      { data, error },
      {
        count: unreadCount,
        error: countError,
      },
      {
        data: preferenceRows,
        error: preferenceError,
      },
    ] = await Promise.all([
      query,
      supabase
        .from(
          'author_page_notifications'
        )
        .select('id', {
          count: 'exact',
          head: true,
        })
        .eq(
          'author_page_id',
          authorPage.id
        )
        .eq('is_read', false),
      supabase
        .from(
          'author_page_notification_preferences'
        )
        .select(
          'type, is_enabled, frequency_level'
        )
        .eq(
          'author_page_id',
          authorPage.id
        ),
    ])

    if (error) throw error
    if (countError) throw countError
    if (preferenceError) {
      throw preferenceError
    }

    const rows = data || []
    const hasMore =
      rows.length > limit
    const visibleRows =
      rows.slice(0, limit)
    const nextCursor =
      hasMore &&
      visibleRows.length
        ? visibleRows[
            visibleRows.length - 1
          ].created_at
        : null

    return res.status(200).json({
      ok: true,
      notifications:
        visibleRows.map(
          normalizeNotification
        ),
      unread_count:
        Number(unreadCount || 0),
      preferences:
        normalizePreferences(
          preferenceRows || []
        ),
      has_more: hasMore,
      next_cursor: nextCursor,
      page_size: limit,
      retention_days:
        RETENTION_DAYS,
      minimum_retained:
        RETAIN_MINIMUM,
    })
  } catch (error) {
    console.error(
      'GET AUTHOR PAGE NOTIFICATIONS ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to load page notifications',
      error: error.message,
    })
  }
}

export async function markMyAuthorPageNotificationRead(
  req,
  res
) {
  try {
    const userId = req.user?.user_id
    const notificationId = String(
      req.params.id || ''
    ).trim()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!notificationId) {
      return res.status(400).json({
        ok: false,
        message:
          'Notification ID is required',
      })
    }

    const authorPage =
      await getMyAuthorPageByUserId(userId)

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message: 'Author page not found',
      })
    }

    const { data, error } = await supabase
      .from('author_page_notifications')
      .update({
        is_read: true,
        read_at: new Date().toISOString(),
      })
      .eq('id', notificationId)
      .eq(
        'author_page_id',
        authorPage.id
      )
      .select()
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({
        ok: false,
        message:
          'Notification not found',
      })
    }

    return res.status(200).json({
      ok: true,
      notification:
        normalizeNotification(data),
    })
  } catch (error) {
    console.error(
      'MARK AUTHOR PAGE NOTIFICATION READ ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to mark notification as read',
      error: error.message,
    })
  }
}

export async function markMyAuthorPageNotificationUnread(
  req,
  res
) {
  try {
    const userId = req.user?.user_id
    const notificationId = String(
      req.params.id || ''
    ).trim()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!notificationId) {
      return res.status(400).json({
        ok: false,
        message:
          'Notification ID is required',
      })
    }

    const authorPage =
      await getMyAuthorPageByUserId(userId)

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message: 'Author page not found',
      })
    }

    const { data, error } = await supabase
      .from('author_page_notifications')
      .update({
        is_read: false,
        read_at: null,
      })
      .eq('id', notificationId)
      .eq(
        'author_page_id',
        authorPage.id
      )
      .select()
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({
        ok: false,
        message:
          'Notification not found',
      })
    }

    return res.status(200).json({
      ok: true,
      notification:
        normalizeNotification(data),
    })
  } catch (error) {
    console.error(
      'MARK AUTHOR PAGE NOTIFICATION UNREAD ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to mark notification as unread',
      error: error.message,
    })
  }
}

export async function deleteMyAuthorPageNotification(
  req,
  res
) {
  try {
    const userId = req.user?.user_id
    const notificationId = String(
      req.params.id || ''
    ).trim()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!notificationId) {
      return res.status(400).json({
        ok: false,
        message:
          'Notification ID is required',
      })
    }

    const authorPage =
      await getMyAuthorPageByUserId(userId)

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message: 'Author page not found',
      })
    }

    const { data, error } = await supabase
      .from('author_page_notifications')
      .delete()
      .eq('id', notificationId)
      .eq(
        'author_page_id',
        authorPage.id
      )
      .select('id')
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({
        ok: false,
        message:
          'Notification not found',
      })
    }

    return res.status(200).json({
      ok: true,
      deleted_id: data.id,
    })
  } catch (error) {
    console.error(
      'DELETE AUTHOR PAGE NOTIFICATION ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to delete notification',
      error: error.message,
    })
  }
}

export async function updateMyAuthorPageNotificationPreference(
  req,
  res
) {
  try {
    const userId = req.user?.user_id
    const type = String(
      req.params.type || ''
    )
      .trim()
      .toLowerCase()
    const isEnabled =
      req.body?.is_enabled !== false
    const frequencyLevel = String(
      req.body?.frequency_level ||
        'normal'
    )
      .trim()
      .toLowerCase()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (!NOTIFICATION_TYPES.has(type)) {
      return res.status(400).json({
        ok: false,
        message:
          'Notification type is not valid',
      })
    }

    if (
      !FREQUENCY_LEVELS.has(
        frequencyLevel
      )
    ) {
      return res.status(400).json({
        ok: false,
        message:
          'Frequency level is not valid',
      })
    }

    const authorPage =
      await getMyAuthorPageByUserId(userId)

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message: 'Author page not found',
      })
    }

    const { data, error } = await supabase
      .from(
        'author_page_notification_preferences'
      )
      .upsert(
        {
          author_page_id: authorPage.id,
          user_id: userId,
          type,
          is_enabled: isEnabled,
          frequency_level:
            frequencyLevel,
          updated_at:
            new Date().toISOString(),
        },
        {
          onConflict:
            'author_page_id,type',
        }
      )
      .select()
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      preference: data,
    })
  } catch (error) {
    console.error(
      'UPDATE AUTHOR PAGE NOTIFICATION PREFERENCE ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to update notification preference',
      error: error.message,
    })
  }
}

export async function markAllMyAuthorPageNotificationsRead(
  req,
  res
) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const authorPage =
      await getMyAuthorPageByUserId(userId)

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message: 'Author page not found',
      })
    }

    const { error } = await supabase
      .from('author_page_notifications')
      .update({
        is_read: true,
        read_at: new Date().toISOString(),
      })
      .eq(
        'author_page_id',
        authorPage.id
      )
      .eq('is_read', false)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message:
        'Notifications marked as read',
    })
  } catch (error) {
    console.error(
      'MARK ALL AUTHOR PAGE NOTIFICATIONS READ ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to mark all notifications as read',
      error: error.message,
    })
  }
}
