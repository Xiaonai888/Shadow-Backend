import { supabase } from '../config/supabase.js'
import { deleteR2ObjectByUrl } from './r2Storage.service.js'

const RETRY_BATCH_SIZE = 25
const RETRY_BASE_DELAY_MS = 60 * 1000
const RETRY_MAX_DELAY_MS = 6 * 60 * 60 * 1000
const WORKER_RECOVERY_DELAY_MS = 15 * 60 * 1000
const MIN_TIMER_DELAY_MS = 1000
const MAX_TIMER_DELAY_MS = 24 * 60 * 60 * 1000

let workerRunning = false
let workerTimer = null
let workerTimerDueAt = 0

function clean(value) {
  return String(value || '').trim()
}

function cleanError(error) {
  return clean(
    error?.message ||
    error?.code ||
    'R2_DELETE_RETRY_FAILED'
  ).slice(0, 1000)
}

function retryDelayMs(attempts) {
  const exponent = Math.min(
    12,
    Math.max(0, Number(attempts || 0))
  )

  return Math.min(
    RETRY_MAX_DELAY_MS,
    RETRY_BASE_DELAY_MS * (2 ** exponent)
  )
}

function clearWorkerTimer() {
  if (workerTimer) {
    clearTimeout(workerTimer)
  }

  workerTimer = null
  workerTimerDueAt = 0
}

function armWorkerTimer(delayMs) {
  const safeDelay = Math.min(
    MAX_TIMER_DELAY_MS,
    Math.max(
      MIN_TIMER_DELAY_MS,
      Number(delayMs || 0)
    )
  )
  const dueAt = Date.now() + safeDelay

  if (
    workerTimer &&
    workerTimerDueAt &&
    workerTimerDueAt <= dueAt
  ) {
    return workerTimer
  }

  clearWorkerTimer()

  workerTimerDueAt = dueAt
  workerTimer = setTimeout(() => {
    workerTimer = null
    workerTimerDueAt = 0
    void runWorkerAndReschedule()
  }, safeDelay)

  workerTimer.unref?.()

  return workerTimer
}

async function deleteQueueRows(ids = []) {
  const cleanIds = [
    ...new Set(
      (Array.isArray(ids) ? ids : [])
        .map((id) => clean(id))
        .filter(Boolean)
    ),
  ]

  if (!cleanIds.length) return 0

  const { error } = await supabase
    .from('manga_r2_delete_retry_queue')
    .delete()
    .in('id', cleanIds)

  if (error) throw error

  return cleanIds.length
}

async function markRetryFailure(row, error) {
  const attempts = Number(row?.attempts || 0) + 1
  const now = new Date()
  const nextRetryAt = new Date(
    now.getTime() + retryDelayMs(attempts)
  ).toISOString()

  const { error: updateError } = await supabase
    .from('manga_r2_delete_retry_queue')
    .update({
      attempts,
      last_error: cleanError(error),
      last_attempt_at: now.toISOString(),
      next_retry_at: nextRetryAt,
      updated_at: now.toISOString(),
    })
    .eq('id', row.id)

  if (updateError) throw updateError
}

async function getReferencedMangaUrls(urls = []) {
  const cleanUrls = [
    ...new Set(
      (Array.isArray(urls) ? urls : [])
        .map((url) => clean(url))
        .filter(Boolean)
    ),
  ]

  if (!cleanUrls.length) {
    return new Set()
  }

  const [
    { data: partRows, error: partError },
    { data: pageRows, error: pageError },
  ] = await Promise.all([
    supabase
      .from('episode_page_parts')
      .select('image_url')
      .in('image_url', cleanUrls),
    supabase
      .from('episode_pages')
      .select('image_url')
      .in('image_url', cleanUrls),
  ])

  if (partError) throw partError
  if (pageError) throw pageError

  return new Set([
    ...(partRows || []).map((row) =>
      clean(row.image_url)
    ),
    ...(pageRows || []).map((row) =>
      clean(row.image_url)
    ),
  ].filter(Boolean))
}

async function loadDueRows() {
  const { data, error } = await supabase
    .from('manga_r2_delete_retry_queue')
    .select(
      'id,image_url,attempts,last_error,last_attempt_at,next_retry_at'
    )
    .lte('next_retry_at', new Date().toISOString())
    .order('next_retry_at', { ascending: true })
    .limit(RETRY_BATCH_SIZE)

  if (error) throw error

  return data || []
}

async function scheduleNextQueuedRetry() {
  const { data, error } = await supabase
    .from('manga_r2_delete_retry_queue')
    .select('next_retry_at')
    .order('next_retry_at', { ascending: true })
    .limit(1)

  if (error) throw error

  const nextRetryAt = data?.[0]?.next_retry_at

  if (!nextRetryAt) {
    clearWorkerTimer()
    return null
  }

  const retryAtMs = new Date(nextRetryAt).getTime()

  if (!Number.isFinite(retryAtMs)) {
    return armWorkerTimer(
      WORKER_RECOVERY_DELAY_MS
    )
  }

  return armWorkerTimer(
    Math.max(
      MIN_TIMER_DELAY_MS,
      retryAtMs - Date.now()
    )
  )
}

export async function runMangaR2DeleteRetryBatch() {
  if (workerRunning) {
    return {
      skipped: true,
      scanned: 0,
      deleted: 0,
      protected: 0,
      failed: 0,
      ignored: 0,
      invalid: 0,
    }
  }

  workerRunning = true

  try {
    const rows = await loadDueRows()
    const summary = {
      skipped: false,
      scanned: rows.length,
      deleted: 0,
      protected: 0,
      failed: 0,
      ignored: 0,
      invalid: 0,
    }

    if (!rows.length) {
      return summary
    }

    const invalidRows = rows.filter(
      (row) =>
        !clean(row?.id) ||
        !clean(row?.image_url)
    )
    const validRows = rows.filter(
      (row) =>
        clean(row?.id) &&
        clean(row?.image_url)
    )

    if (invalidRows.length) {
      const invalidIds = invalidRows
        .map((row) => clean(row?.id))
        .filter(Boolean)

      if (invalidIds.length) {
        await deleteQueueRows(invalidIds)
      }

      summary.invalid += invalidRows.length
    }

    if (!validRows.length) {
      return summary
    }

    const referencedUrls =
      await getReferencedMangaUrls(
        validRows.map((row) => row.image_url)
      )

    const protectedRows = validRows.filter(
      (row) =>
        referencedUrls.has(clean(row.image_url))
    )
    const deleteRows = validRows.filter(
      (row) =>
        !referencedUrls.has(clean(row.image_url))
    )

    if (protectedRows.length) {
      await deleteQueueRows(
        protectedRows.map((row) => row.id)
      )

      summary.protected += protectedRows.length
    }

    if (!deleteRows.length) {
      return summary
    }

    const deleteResults =
      await Promise.allSettled(
        deleteRows.map((row) =>
          deleteR2ObjectByUrl(row.image_url)
        )
      )

    const removeIds = []
    const failedRows = []

    deleteResults.forEach((result, index) => {
      const row = deleteRows[index]

      if (
        result.status === 'fulfilled' &&
        result.value === true
      ) {
        summary.deleted += 1
        removeIds.push(row.id)
        return
      }

      if (
        result.status === 'fulfilled' &&
        result.value === false
      ) {
        summary.ignored += 1
        removeIds.push(row.id)
        return
      }

      summary.failed += 1
      failedRows.push({
        row,
        error: result.reason,
      })
    })

    if (removeIds.length) {
      await deleteQueueRows(removeIds)
    }

    for (const item of failedRows) {
      try {
        await markRetryFailure(
          item.row,
          item.error
        )
      } catch (error) {
        console.error(
          'MANGA_R2_DELETE_RETRY_UPDATE_ERROR:',
          item.row?.id,
          error
        )
      }
    }

    return summary
  } finally {
    workerRunning = false
  }
}

async function runWorkerAndReschedule() {
  try {
    const result =
      await runMangaR2DeleteRetryBatch()

    if (
      result.scanned ||
      result.failed
    ) {
      console.log(
        'MANGA_R2_DELETE_RETRY:',
        JSON.stringify(result)
      )
    }

    await scheduleNextQueuedRetry()
  } catch (error) {
    console.error(
      'MANGA_R2_DELETE_RETRY_ERROR:',
      error
    )

    armWorkerTimer(
      WORKER_RECOVERY_DELAY_MS
    )
  }
}

export function wakeMangaR2DeleteRetryWorker(
  delayMs = RETRY_BASE_DELAY_MS
) {
  return armWorkerTimer(delayMs)
}

export async function startMangaR2DeleteRetryWorker() {
  try {
    return await scheduleNextQueuedRetry()
  } catch (error) {
    console.error(
      'MANGA_R2_DELETE_RETRY_START_ERROR:',
      error
    )

    return armWorkerTimer(
      WORKER_RECOVERY_DELAY_MS
    )
  }
}
