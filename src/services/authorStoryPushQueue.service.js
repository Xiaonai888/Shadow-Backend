import { supabase } from '../config/supabase.js'
import { sendAuthorStoryPushSafely } from './authorStoryPush.service.js'

const IDLE_CHECK_MS = 10 * 60 * 1000
const ACTIVE_CHECK_MS = 1200
const ERROR_RETRY_MS = 60 * 1000
const MAX_ERROR_RETRY_MS = 30 * 60 * 1000
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const BATCH_SIZE = 12
const CONCURRENCY = 3

let started = false
let running = false
let timer = null
let timerDueAt = 0
let lastCleanupAt = 0
let wakeRequested = false
let consecutiveFailures = 0
let retryNotBefore = 0
let firstClaimLogged = false

function getConfigStatus() {
  const queueEnabled = String(process.env.AUTHOR_STORY_PUSH_QUEUE_ENABLED ?? 'true').trim().toLowerCase() !== 'false'
  const appId = Boolean(String(process.env.ONESIGNAL_APP_ID || '').trim())
  const apiKey = Boolean(String(process.env.ONESIGNAL_REST_API_KEY || '').trim())
  return { enabled: queueEnabled && appId && apiKey, queueEnabled, appId, apiKey }
}

function enabled() {
  return getConfigStatus().enabled
}

function schedule(delay) {
  if (!started || !enabled()) return

  const dueAt = Math.max(Date.now() + Math.max(0, Number(delay) || 0), retryNotBefore)
  if (timer && timerDueAt <= dueAt) return
  if (timer) clearTimeout(timer)

  timerDueAt = dueAt
  timer = setTimeout(() => {
    timer = null
    timerDueAt = 0
    void processAuthorStoryPushQueue()
  }, Math.max(0, dueAt - Date.now()))
  timer.unref?.()
}

async function processJob(job) {
  try {
    const sent = await sendAuthorStoryPushSafely(job.payload, { throwOnFailure: true })
    return { id: job.id, claim_token: job.claim_token, outcome: sent ? 'sent' : 'skipped', error: '' }
  } catch (error) {
    return {
      id: job.id,
      claim_token: job.claim_token,
      outcome: 'retry',
      error: String(error?.message || error).slice(0, 300),
    }
  }
}

function getRetryDelay(job) {
  const attempts = Math.max(0, Math.min(8, Math.floor(Number(job?.attempts) || 0)))
  return Math.min(MAX_ERROR_RETRY_MS, 10000 * (2 ** attempts)) + 1500
}

async function cleanOldResults() {
  const now = Date.now()
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return
  lastCleanupAt = now

  try {
    const cutoff = new Date(now - RETENTION_MS).toISOString()
    const { error } = await supabase
      .from('author_story_push_jobs')
      .delete()
      .in('status', ['sent', 'skipped'])
      .lt('updated_at', cutoff)
    if (error) throw error
  } catch (error) {
    console.error('AUTHOR STORY PUSH CLEANUP ERROR:', error?.message || error)
  }
}

async function processAuthorStoryPushQueue() {
  if (running || !started || !enabled()) return
  running = true
  let nextDelay = IDLE_CHECK_MS

  try {
    const { data, error } = await supabase.rpc('claim_author_story_push_jobs', { p_limit: BATCH_SIZE })
    if (error) throw error

    const jobs = Array.isArray(data) ? data : []
    if (!firstClaimLogged) {
      firstClaimLogged = true
      console.info('AUTHOR_PUSH_WORKER_READY', { claimed: jobs.length })
    }

    if (jobs.length) {
      const results = []
      for (let index = 0; index < jobs.length; index += CONCURRENCY) {
        results.push(...await Promise.all(jobs.slice(index, index + CONCURRENCY).map(processJob)))
      }

      const { data: completed, error: finishError } = await supabase.rpc('finish_author_story_push_jobs', { p_results: results })
      if (finishError) throw finishError

      const completedCount = Number(completed)
      const sentCount = results.filter((item) => item.outcome === 'sent').length
      const skippedCount = results.filter((item) => item.outcome === 'skipped').length
      const retryCount = results.filter((item) => item.outcome === 'retry').length

      console.info('AUTHOR_PUSH_BATCH', {
        claimed: jobs.length,
        completed: completedCount,
        sent: sentCount,
        skipped: skippedCount,
        retry: retryCount,
      })

      if (completedCount !== jobs.length) {
        console.warn('AUTHOR STORY PUSH QUEUE FINISH COUNT', completedCount, jobs.length)
        nextDelay = ACTIVE_CHECK_MS
      } else if (jobs.length === BATCH_SIZE) {
        nextDelay = ACTIVE_CHECK_MS
      } else if (retryCount) {
        const retryDelays = results.flatMap((result, index) =>
          result.outcome === 'retry' ? [getRetryDelay(jobs[index])] : []
        )
        nextDelay = Math.min(...retryDelays)
      }
    }

    consecutiveFailures = 0
    retryNotBefore = 0
    await cleanOldResults()
  } catch (error) {
    consecutiveFailures = Math.min(10, consecutiveFailures + 1)
    retryNotBefore = Date.now() + Math.min(MAX_ERROR_RETRY_MS, ERROR_RETRY_MS * (2 ** (consecutiveFailures - 1)))
    console.error('AUTHOR STORY PUSH QUEUE ERROR:', error?.message || error)
  } finally {
    running = false
    const delay = wakeRequested ? 50 : nextDelay
    wakeRequested = false
    schedule(delay)
  }
}

export function wakeAuthorStoryPushQueue() {
  if (!started || !enabled()) return
  if (running) {
    wakeRequested = true
    return
  }
  schedule(50)
}

export function startAuthorStoryPushQueue() {
  if (started) return

  const status = getConfigStatus()
  console.info('AUTHOR_PUSH_STARTUP')
  if (!status.enabled) return

  started = true
  schedule(1000)
}
