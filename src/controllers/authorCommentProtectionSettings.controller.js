import { supabase } from '../config/supabase.js'
import {
  saveAuthorCommentActivityLogSafely,
} from '../services/authorCommentActivity.service.js'
import {
  runAuthorCommentCleanupForAuthor,
} from '../services/authorCommentCleanup.service.js'

const VALID_RETENTION_DAYS =
  new Set([7, 14, 30])
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const MAX_HISTORY_ROWS = 1000

function cleanText(value) {
  return String(value || '')
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') {
    return value
  }

  const normalized =
    cleanText(value).toLowerCase()

  if (
    normalized === 'true' ||
    normalized === '1'
  ) {
    return true
  }

  if (
    normalized === 'false' ||
    normalized === '0'
  ) {
    return false
  }

  return null
}

function normalizeRetentionDays(value) {
  const days = Number(value)

  return VALID_RETENTION_DAYS.has(days)
    ? days
    : null
}

function normalizePage(value) {
  const page = Number(value)

  return (
    Number.isFinite(page) &&
    page > 0
  )
    ? Math.floor(page)
    : 1
}

function normalizeLimit(value) {
  const limit = Number(value)

  if (
    !Number.isFinite(limit) ||
    limit < 1
  ) {
    return DEFAULT_LIMIT
  }

  return Math.min(
    MAX_LIMIT,
    Math.floor(limit)
  )
}

async function getMyAuthorPage(userId) {
  const { data, error } = await supabase
    .from('author_pages')
    .select('id, user_id')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error

  return data
}

function publicSetting(
  row,
  authorPageId,
  authorUserId
) {
  return {
    author_page_id:
      row?.author_page_id ||
      authorPageId,
    author_user_id:
      row?.author_user_id ||
      authorUserId,
    enabled:
      Boolean(row?.enabled),
    retention_days:
      VALID_RETENTION_DAYS.has(
        Number(
          row?.retention_days
        )
      )
        ? Number(
            row.retention_days
          )
        : 30,
    last_cleanup_at:
      row?.last_cleanup_at ||
      null,
    last_cleanup_count:
      Math.max(
        0,
        Number(
          row?.last_cleanup_count ||
          0
        )
      ),
    last_cleanup_error:
      row?.last_cleanup_error ||
      '',
    created_at:
      row?.created_at || null,
    updated_at:
      row?.updated_at || null,
  }
}

function publicLog(row) {
  return {
    id: row.id,
    actor_type:
      row.actor_type,
    actor_user_id:
      row.actor_user_id ||
      null,
    action_type:
      row.action_type,
    target_type:
      row.target_type,
    target_id:
      row.target_id || null,
    summary:
      row.summary || '',
    metadata:
      row.metadata &&
      typeof row.metadata ===
        'object'
        ? row.metadata
        : {},
    created_at:
      row.created_at,
  }
}

function matchesHistorySearch(
  item,
  search
) {
  if (!search) return true

  const values = [
    item.action_type,
    item.target_type,
    item.target_id,
    item.summary,
    JSON.stringify(
      item.metadata || {}
    ),
  ]

  return values.some((value) =>
    String(value || '')
      .toLowerCase()
      .includes(search)
  )
}

export async function getMyAuthorCommentCleanupSettings(
  req,
  res
) {
  try {
    const userId =
      req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const authorPage =
      await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message:
          'Author page not found',
      })
    }

    const authorPageId =
      String(authorPage.id)
    const authorUserId =
      String(userId)
    const {
      data,
      error,
    } = await supabase
      .from(
        'author_comment_cleanup_settings'
      )
      .select('*')
      .eq(
        'author_page_id',
        authorPageId
      )
      .eq(
        'author_user_id',
        authorUserId
      )
      .maybeSingle()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      setting:
        publicSetting(
          data,
          authorPageId,
          authorUserId
        ),
    })
  } catch (error) {
    console.error(
      'GET AUTHOR COMMENT CLEANUP SETTINGS ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to load Auto Cleanup settings',
      error: error.message,
    })
  }
}

export async function updateMyAuthorCommentCleanupSettings(
  req,
  res
) {
  try {
    const userId =
      req.user?.user_id
    const enabled =
      normalizeBoolean(
        req.body?.enabled
      )
    const retentionDays =
      normalizeRetentionDays(
        req.body?.retention_days ||
        req.body?.retentionDays
      )

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    if (enabled === null) {
      return res.status(400).json({
        ok: false,
        message:
          'Enabled must be true or false',
      })
    }

    if (!retentionDays) {
      return res.status(400).json({
        ok: false,
        message:
          'Retention days must be 7, 14 or 30',
      })
    }

    const authorPage =
      await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message:
          'Author page not found',
      })
    }

    const authorPageId =
      String(authorPage.id)
    const authorUserId =
      String(userId)
    const {
      data: previous,
      error: previousError,
    } = await supabase
      .from(
        'author_comment_cleanup_settings'
      )
      .select('*')
      .eq(
        'author_page_id',
        authorPageId
      )
      .maybeSingle()

    if (previousError) {
      throw previousError
    }

    const now =
      new Date().toISOString()
    const payload = {
      author_page_id:
        authorPageId,
      author_user_id:
        authorUserId,
      enabled,
      retention_days:
        retentionDays,
      updated_at: now,
    }

    const {
      data,
      error,
    } = await supabase
      .from(
        'author_comment_cleanup_settings'
      )
      .upsert(
        previous
          ? payload
          : {
              ...payload,
              created_at: now,
            },
        {
          onConflict:
            'author_page_id',
        }
      )
      .select('*')
      .single()

    if (error) throw error

    await saveAuthorCommentActivityLogSafely({
      authorPageId,
      authorUserId,
      actorType: 'author',
      actorUserId:
        authorUserId,
      actionType:
        'cleanup_settings_updated',
      targetType:
        'cleanup_settings',
      targetId:
        authorPageId,
      summary:
        enabled
          ? `Enabled Auto Cleanup after ${retentionDays} days`
          : 'Disabled Auto Cleanup',
      metadata: {
        previous_enabled:
          Boolean(
            previous?.enabled
          ),
        previous_retention_days:
          Number(
            previous?.retention_days ||
            30
          ),
        enabled,
        retention_days:
          retentionDays,
      },
    })

    return res.status(200).json({
      ok: true,
      message:
        enabled
          ? 'Auto Cleanup enabled'
          : 'Auto Cleanup disabled',
      setting:
        publicSetting(
          data,
          authorPageId,
          authorUserId
        ),
    })
  } catch (error) {
    console.error(
      'UPDATE AUTHOR COMMENT CLEANUP SETTINGS ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to save Auto Cleanup settings',
      error: error.message,
    })
  }
}

export async function runMyAuthorCommentCleanupNow(
  req,
  res
) {
  try {
    const userId =
      req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const authorPage =
      await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message:
          'Author page not found',
      })
    }

    const result =
      await runAuthorCommentCleanupForAuthor({
        authorPageId:
          authorPage.id,
        authorUserId:
          userId,
      })

    return res.status(
      result.ok ? 200 : 500
    ).json({
      ...result,
      message:
        result.ok
          ? `Auto Cleanup completed. ${result.cleaned_count} comment${result.cleaned_count === 1 ? '' : 's'} moved to Trash.`
          : result.error ||
            'Auto Cleanup failed',
    })
  } catch (error) {
    console.error(
      'RUN AUTHOR COMMENT CLEANUP NOW ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to run Auto Cleanup',
      error: error.message,
    })
  }
}

export async function getMyAuthorModerationHistory(
  req,
  res
) {
  try {
    const userId =
      req.user?.user_id

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const authorPage =
      await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(404).json({
        ok: false,
        message:
          'Author page not found',
      })
    }

    const page =
      normalizePage(req.query.page)
    const limit =
      normalizeLimit(req.query.limit)
    const actionType =
      cleanText(
        req.query.action_type ||
        req.query.action ||
        'all'
      ).toLowerCase()
    const search =
      cleanText(
        req.query.search ||
        req.query.q
      ).toLowerCase()

    const { data, error } = await supabase
      .from(
        'author_comment_activity_logs'
      )
      .select('*')
      .eq(
        'author_page_id',
        String(authorPage.id)
      )
      .eq(
        'author_user_id',
        String(userId)
      )
      .order(
        'created_at',
        { ascending: false }
      )
      .limit(MAX_HISTORY_ROWS)

    if (error) throw error

    const allLogs =
      (data || []).map(
        publicLog
      )
    const counts = {}

    for (const item of allLogs) {
      counts[item.action_type] =
        Number(
          counts[
            item.action_type
          ] || 0
        ) + 1
    }

    const filtered =
      allLogs.filter(
        (item) =>
          (
            actionType === 'all' ||
            item.action_type ===
              actionType
          ) &&
          matchesHistorySearch(
            item,
            search
          )
      )
    const total =
      filtered.length
    const totalPages =
      Math.max(
        1,
        Math.ceil(total / limit)
      )
    const safePage =
      Math.min(page, totalPages)
    const from =
      (safePage - 1) * limit

    return res.status(200).json({
      ok: true,
      page: safePage,
      limit,
      total,
      total_pages:
        totalPages,
      action_type:
        actionType,
      counts,
      available_actions:
        Object.keys(counts).sort(),
      logs:
        filtered.slice(
          from,
          from + limit
        ),
    })
  } catch (error) {
    console.error(
      'GET AUTHOR MODERATION HISTORY ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to load Moderation History',
      error: error.message,
    })
  }
}
