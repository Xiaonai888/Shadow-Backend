import { supabase } from '../config/supabase.js'
import {
  deleteStoryCommentToTrash,
} from './commentTrash.service.js'
import {
  saveAuthorCommentActivityLogSafely,
} from './authorCommentActivity.service.js'

const CLEANUP_INTERVAL_MS =
  6 * 60 * 60 * 1000
const CLEANUP_START_DELAY_MS =
  90 * 1000
const MAX_SETTINGS_PER_RUN = 300
const MAX_COMMENTS_PER_AUTHOR = 30
const VALID_RETENTION_DAYS =
  new Set([7, 14, 30])

let cleanupStarted = false
let cleanupRunning = false

function normalizeRetentionDays(value) {
  const days = Number(value)

  return VALID_RETENTION_DAYS.has(days)
    ? days
    : 30
}

function errorMessage(error) {
  return String(
    error?.message ||
    error ||
    ''
  )
    .trim()
    .slice(0, 500)
}

async function markReviewDeleted({
  reviewId,
  authorUserId,
}) {
  const { error } = await supabase
    .from(
      'author_hidden_comment_reviews'
    )
    .update({
      status: 'deleted',
      reviewed_at:
        new Date().toISOString(),
    })
    .eq('id', reviewId)
    .eq(
      'author_user_id',
      String(authorUserId)
    )

  if (error) throw error
}

async function updateCleanupResult({
  authorPageId,
  cleanedCount,
  errorText,
}) {
  const { error } = await supabase
    .from(
      'author_comment_cleanup_settings'
    )
    .update({
      last_cleanup_at:
        new Date().toISOString(),
      last_cleanup_count:
        Math.max(
          0,
          Number(cleanedCount || 0)
        ),
      last_cleanup_error:
        errorText || null,
      updated_at:
        new Date().toISOString(),
    })
    .eq(
      'author_page_id',
      String(authorPageId)
    )

  if (error) throw error
}

export async function runAuthorCommentCleanupForSetting(
  setting
) {
  const authorPageId =
    String(
      setting?.author_page_id || ''
    ).trim()
  const authorUserId =
    String(
      setting?.author_user_id || ''
    ).trim()
  const retentionDays =
    normalizeRetentionDays(
      setting?.retention_days
    )

  if (
    !authorPageId ||
    !authorUserId
  ) {
    return {
      ok: false,
      cleaned_count: 0,
      error:
        'Invalid cleanup setting',
    }
  }

  const cutoff =
    new Date(
      Date.now() -
      retentionDays *
        24 *
        60 *
        60 *
        1000
    ).toISOString()

  try {
    const {
      data: reviews,
      error: reviewError,
    } = await supabase
      .from(
        'author_hidden_comment_reviews'
      )
      .select(
        'id, comment_id, story_id, episode_id, reader_user_id, reviewed_at, comment_text'
      )
      .eq(
        'author_page_id',
        authorPageId
      )
      .eq(
        'author_user_id',
        authorUserId
      )
      .eq(
        'status',
        'kept_hidden'
      )
      .not(
        'reviewed_at',
        'is',
        null
      )
      .lte(
        'reviewed_at',
        cutoff
      )
      .order(
        'reviewed_at',
        { ascending: true }
      )
      .limit(
        MAX_COMMENTS_PER_AUTHOR
      )

    if (reviewError) {
      throw reviewError
    }

    let cleanedCount = 0
    const errors = []

    for (const review of reviews || []) {
      try {
        const result =
          await deleteStoryCommentToTrash({
            commentId:
              review.comment_id,
            actorType: 'author',
            actorId:
              authorUserId,
            reason:
              `Auto cleanup after ${retentionDays} days in Keep Hidden`,
          })

        const alreadyDeleted =
          result?.code ===
          'COMMENT_ALREADY_DELETED'

        if (
          !result?.ok &&
          !alreadyDeleted
        ) {
          errors.push(
            result?.code ||
            'COMMENT_CLEANUP_FAILED'
          )

          if (
            result?.code ===
            'COMMENT_DELETE_LIMIT_REACHED'
          ) {
            break
          }

          continue
        }

        await markReviewDeleted({
          reviewId: review.id,
          authorUserId,
        })

        cleanedCount += 1

        await saveAuthorCommentActivityLogSafely({
          authorPageId,
          authorUserId,
          actorType: 'system',
          actorUserId: null,
          actionType:
            'comment_auto_cleaned',
          targetType: 'comment',
          targetId:
            review.comment_id,
          summary:
            `Moved a Keep Hidden comment to Trash after ${retentionDays} days`,
          metadata: {
            review_id:
              review.id,
            story_id:
              review.story_id,
            episode_id:
              review.episode_id ||
              null,
            reader_user_id:
              review.reader_user_id,
            kept_hidden_at:
              review.reviewed_at,
            retention_days:
              retentionDays,
            already_deleted:
              alreadyDeleted,
          },
        })
      } catch (error) {
        errors.push(
          errorMessage(error) ||
          'COMMENT_CLEANUP_FAILED'
        )
      }
    }

    const lastError =
      errors.length
        ? errors
            .slice(0, 5)
            .join(', ')
            .slice(0, 500)
        : ''

    await updateCleanupResult({
      authorPageId,
      cleanedCount,
      errorText: lastError,
    })

    if (
      cleanedCount > 0 ||
      lastError
    ) {
      await saveAuthorCommentActivityLogSafely({
        authorPageId,
        authorUserId,
        actorType: 'system',
        actorUserId: null,
        actionType:
          'auto_cleanup_completed',
        targetType:
          'cleanup_settings',
        targetId:
          authorPageId,
        summary:
          cleanedCount > 0
            ? `Auto Cleanup moved ${cleanedCount} comment${cleanedCount === 1 ? '' : 's'} to Trash`
            : 'Auto Cleanup completed with no moved comments',
        metadata: {
          cleaned_count:
            cleanedCount,
          retention_days:
            retentionDays,
          cutoff,
          error:
            lastError || null,
        },
      })
    }

    return {
      ok: !lastError,
      cleaned_count:
        cleanedCount,
      retention_days:
        retentionDays,
      error:
        lastError || null,
    }
  } catch (error) {
    const message =
      errorMessage(error) ||
      'Auto Cleanup failed'

    try {
      await updateCleanupResult({
        authorPageId,
        cleanedCount: 0,
        errorText: message,
      })
    } catch (updateError) {
      console.error(
        'AUTHOR COMMENT CLEANUP RESULT ERROR:',
        updateError
      )
    }

    await saveAuthorCommentActivityLogSafely({
      authorPageId,
      authorUserId,
      actorType: 'system',
      actorUserId: null,
      actionType:
        'auto_cleanup_failed',
      targetType:
        'cleanup_settings',
      targetId:
        authorPageId,
      summary:
        'Auto Cleanup failed',
      metadata: {
        retention_days:
          retentionDays,
        error: message,
      },
    })

    return {
      ok: false,
      cleaned_count: 0,
      retention_days:
        retentionDays,
      error: message,
    }
  }
}

export async function runAuthorCommentCleanupForAuthor({
  authorPageId,
  authorUserId,
}) {
  const {
    data: setting,
    error,
  } = await supabase
    .from(
      'author_comment_cleanup_settings'
    )
    .select('*')
    .eq(
      'author_page_id',
      String(authorPageId)
    )
    .eq(
      'author_user_id',
      String(authorUserId)
    )
    .maybeSingle()

  if (error) throw error

  return runAuthorCommentCleanupForSetting(
    setting || {
      author_page_id:
        String(authorPageId),
      author_user_id:
        String(authorUserId),
      enabled: false,
      retention_days: 30,
    }
  )
}

export async function runAuthorCommentCleanup() {
  if (cleanupRunning) {
    return {
      ok: true,
      skipped: true,
    }
  }

  cleanupRunning = true

  try {
    const {
      data: settings,
      error,
    } = await supabase
      .from(
        'author_comment_cleanup_settings'
      )
      .select('*')
      .eq('enabled', true)
      .order(
        'updated_at',
        { ascending: true }
      )
      .limit(
        MAX_SETTINGS_PER_RUN
      )

    if (error) throw error

    let authorsProcessed = 0
    let commentsCleaned = 0

    for (const setting of settings || []) {
      const result =
        await runAuthorCommentCleanupForSetting(
          setting
        )

      authorsProcessed += 1
      commentsCleaned +=
        Number(
          result.cleaned_count || 0
        )
    }

    return {
      ok: true,
      authors_processed:
        authorsProcessed,
      cleaned_count:
        commentsCleaned,
    }
  } catch (error) {
    console.error(
      'AUTHOR COMMENT AUTO CLEANUP ERROR:',
      error
    )

    return {
      ok: false,
      error:
        errorMessage(error),
    }
  } finally {
    cleanupRunning = false
  }
}

export function startAuthorCommentCleanup() {
  if (
    cleanupStarted ||
    process.env
      .ENABLE_AUTHOR_COMMENT_AUTO_CLEANUP ===
      'false'
  ) {
    return
  }

  cleanupStarted = true

  const startTimer =
    setTimeout(() => {
      runAuthorCommentCleanup()
    }, CLEANUP_START_DELAY_MS)

  const interval =
    setInterval(() => {
      runAuthorCommentCleanup()
    }, CLEANUP_INTERVAL_MS)

  startTimer.unref?.()
  interval.unref?.()
}
