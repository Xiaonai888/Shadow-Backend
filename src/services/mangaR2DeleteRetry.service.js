import { supabase } from '../config/supabase.js'
import { deleteR2ObjectByUrl } from './r2Storage.service.js'

const RETRY_BATCH_SIZE = 25
const RETRY_INTERVAL_MS = 60 * 1000
const RETRY_BASE_DELAY_MS = 60 * 1000
const RETRY_MAX_DELAY_MS = 6 * 60 * 60 * 1000

let workerRunning = false
let workerTimer = null

function clean(value) {
  return String(value || '').trim()
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

function cleanError(error) {
  return clean(
    error?.message ||
    error?.code ||
    'R2_DELETE_RETRY_FAILED'
  ).slice(0, 1000)
}

async function removeQueueRow(id) {
  const { error } = await supabase
    .from('manga_r2_delete_retry_queue')
    .delete()
    .eq('id', id)

  if (error) throw error
}

async function mangaUrlIsReferenced(imageUrl) {
  const url = clean(imageUrl)
  if (!url) return false

  const [
    { data: partRows, error: partError },
    { data: pageRows, error: pageError },
  ] = await Promise.all([
    supabase
      .from('episode_page_parts')
      .select('id')
      .eq('image_url', url)
      .limit(1),
    supabase
      .from('episode_pages')
      .select('id')
      .eq('image_url', url)
      .limit(1),
  ])

  if (partError) throw partError
  if (pageError) throw pageError

  return Boolean(
    (partRows || []).length ||
    (pageRows || []).length
  )
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

async function processRetryRow(row) {
  const imageUrl = clean(row?.image_url)

  if (!row?.id || !imageUrl) {
    if (row?.id) {
      await removeQueueRow(row.id)
    }

    return 'invalid'
  }

  if (await mangaUrlIsReferenced(imageUrl)) {
    await removeQueueRow(row.id)
    return 'protected'
  }

  try {
    const deleted = await deleteR2ObjectByUrl(imageUrl)

    if (!deleted) {
      await removeQueueRow(row.id)
      return 'ignored'
    }

    await removeQueueRow(row.id)
    return 'deleted'
  } catch (error) {
    await markRetryFailure(row, error)
    return 'failed'
  }
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
    const now = new Date().toISOString()

    const { data: rows, error } = await supabase
      .from('manga_r2_delete_retry_queue')
      .select(
        'id,image_url,attempts,last_error,last_attempt_at,next_retry_at'
      )
      .lte('next_retry_at', now)
      .order('next_retry_at', { ascending: true })
      .limit(RETRY_BATCH_SIZE)

    if (error) throw error

    const summary = {
      skipped: false,
      scanned: (rows || []).length,
      deleted: 0,
      protected: 0,
      failed: 0,
      ignored: 0,
      invalid: 0,
    }

    for (const row of rows || []) {
      try {
        const result = await processRetryRow(row)

        if (
          Object.prototype.hasOwnProperty.call(
            summary,
            result
          )
        ) {
          summary[result] += 1
        }
      } catch (error) {
        summary.failed += 1

        console.error(
          'MANGA_R2_DELETE_RETRY_ROW_ERROR:',
          row?.id,
          error
        )
      }
    }

    return summary
  } finally {
    workerRunning = false
  }
}

export function startMangaR2DeleteRetryWorker() {
  if (workerTimer) return workerTimer

  const run = () => {
    runMangaR2DeleteRetryBatch()
      .then((result) => {
        if (
          result.scanned ||
          result.failed
        ) {
          console.log(
            'MANGA_R2_DELETE_RETRY:',
            JSON.stringify(result)
          )
        }
      })
      .catch((error) => {
        console.error(
          'MANGA_R2_DELETE_RETRY_ERROR:',
          error
        )
      })
  }

  run()

  workerTimer = setInterval(
    run,
    RETRY_INTERVAL_MS
  )

  workerTimer.unref?.()

  return workerTimer
}
