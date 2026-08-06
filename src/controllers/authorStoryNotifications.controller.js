import { supabase } from '../config/supabase.js'

const NOTIFICATION_TYPES = new Set([
  'comment',
  'like',
  'echo',
  'unlock',
  'income',
  'gift',
  'system',
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

function normalizePreferences(rows = []) {
  const preferences = {}

  for (const row of rows) {
    preferences[row.type] = {
      is_enabled: row.is_enabled !== false,
      frequency_level:
        FREQUENCY_LEVELS.has(
          row.frequency_level
        )
          ? row.frequency_level
          : 'normal',
    }
  }

  return preferences
}

function parseBeforeCursor(value) {
  const cleanValue = String(value || '').trim()

  if (!cleanValue) return ''

  const parsed = new Date(cleanValue)

  if (Number.isNaN(parsed.getTime())) {
    return null
  }

  return parsed.toISOString()
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

async function cleanupOldAuthorStoryNotifications(
  authorId
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
    .from('author_story_notifications')
    .select('id')
    .eq('author_id', authorId)
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
    .from('author_story_notifications')
    .select('id')
    .eq('author_id', authorId)
    .lt('created_at', cutoff)
    .order('created_at', {
      ascending: true,
    })
    .limit(CLEANUP_BATCH_SIZE)

  if (oldRowsError) throw oldRowsError

  const deleteIds = (oldRows || [])
    .map((item) => item.id)
    .filter(
      (id) => !keepIds.has(String(id))
    )

  if (!deleteIds.length) return

  const { error: deleteError } =
    await supabase
      .from('author_story_notifications')
      .delete()
      .in('id', deleteIds)

  if (deleteError) throw deleteError
}

export async function getMyAuthorStoryNotifications(
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
      await getAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({
        ok: false,
        message:
          'Author access is required',
      })
    }

    await cleanupOldAuthorStoryNotifications(
      authorPage.id
    ).catch((error) => {
      console.error(
        'CLEANUP AUTHOR STORY NOTIFICATIONS ERROR:',
        error
      )
    })

    let query = supabase
      .from('author_story_notifications')
      .select('*')
      .eq('author_id', authorPage.id)
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
      query = query.eq('type', type)
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
        count,
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
          'author_story_notifications'
        )
        .select('id', {
          count: 'exact',
          head: true,
        })
        .eq(
          'author_id',
          authorPage.id
        )
        .eq('is_read', false),
      supabase
        .from(
          'author_story_notification_preferences'
        )
        .select(
          'type, is_enabled, frequency_level'
        )
        .eq(
          'author_id',
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
    const visibleRows = rows.slice(
      0,
      limit
    )
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
        Number(count || 0),
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
      'GET AUTHOR STORY NOTIFICATIONS ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to load story notifications',
      error: error.message,
    })
  }
}

export async function markMyAuthorStoryNotificationRead(
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
      await getAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({
        ok: false,
        message:
          'Author access is required',
      })
    }

    const { data, error } =
      await supabase
        .from(
          'author_story_notifications'
        )
        .update({
          is_read: true,
          read_at:
            new Date().toISOString(),
        })
        .eq('id', notificationId)
        .eq(
          'author_id',
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
      'MARK AUTHOR STORY NOTIFICATION READ ERROR:',
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

export async function markMyAuthorStoryNotificationUnread(
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
      await getAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({
        ok: false,
        message:
          'Author access is required',
      })
    }

    const { data, error } =
      await supabase
        .from(
          'author_story_notifications'
        )
        .update({
          is_read: false,
          read_at: null,
        })
        .eq('id', notificationId)
        .eq(
          'author_id',
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
      'MARK AUTHOR STORY NOTIFICATION UNREAD ERROR:',
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

export async function deleteMyAuthorStoryNotification(
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
      await getAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({
        ok: false,
        message:
          'Author access is required',
      })
    }

    const { data, error } =
      await supabase
        .from(
          'author_story_notifications'
        )
        .delete()
        .eq('id', notificationId)
        .eq(
          'author_id',
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
      'DELETE AUTHOR STORY NOTIFICATION ERROR:',
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

export async function updateMyAuthorStoryNotificationPreference(
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
      await getAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({
        ok: false,
        message:
          'Author access is required',
      })
    }

    const { data, error } =
      await supabase
        .from(
          'author_story_notification_preferences'
        )
        .upsert(
          {
            author_id:
              authorPage.id,
            author_user_id:
              userId,
            type,
            is_enabled:
              isEnabled,
            frequency_level:
              frequencyLevel,
            updated_at:
              new Date().toISOString(),
          },
          {
            onConflict:
              'author_id,type',
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
      'UPDATE AUTHOR STORY NOTIFICATION PREFERENCE ERROR:',
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

export async function markAllMyAuthorStoryNotificationsRead(
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
      await getAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({
        ok: false,
        message:
          'Author access is required',
      })
    }

    const { error } = await supabase
      .from(
        'author_story_notifications'
      )
      .update({
        is_read: true,
        read_at:
          new Date().toISOString(),
      })
      .eq(
        'author_id',
        authorPage.id
      )
      .eq('is_read', false)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message:
        'Story notifications marked as read',
    })
  } catch (error) {
    console.error(
      'MARK ALL AUTHOR STORY NOTIFICATIONS READ ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to mark notifications as read',
      error: error.message,
    })
  }
}
