import { runAuthorPreOrderNotificationWorkerCycle } from './authorPreOrderNotificationWorkerCycle.service.js'
import {
  AUTHOR_PREORDER_NOTIFY_INTERVAL_MS,
  AUTHOR_PREORDER_NOTIFY_ERROR_INTERVAL_MS,
  AUTHOR_PREORDER_NOTIFY_BATCH_LIMIT,
  authorPreOrderNotificationWorkerEnabled,
} from './authorPreOrderNotificationWorkerPolicy.service.js'

let started = false
let running = false
let timer = null
let nextRunAt = null
let lastRunAt = null
let lastSuccessAt = null
let lastErrorCode = null
let lastResult = null

function schedule(delay) {
  if (!started || !authorPreOrderNotificationWorkerEnabled()) return
  if (timer) clearTimeout(timer)
  nextRunAt = new Date(Date.now() + delay).toISOString()
  timer = setTimeout(() => {
    timer = null
    nextRunAt = null
    void execute()
  }, delay)
  timer.unref?.()
}

async function execute() {
  if (!started || !authorPreOrderNotificationWorkerEnabled() || running) return
  running = true
  lastRunAt = new Date().toISOString()
  let delay = AUTHOR_PREORDER_NOTIFY_INTERVAL_MS
  try {
    const result = await runAuthorPreOrderNotificationWorkerCycle({
      limit: AUTHOR_PREORDER_NOTIFY_BATCH_LIMIT,
    })
    lastResult = result
    lastErrorCode = null
    lastSuccessAt = new Date().toISOString()
    if (result.failed_jobs) {
      console.warn('PRE_ORDER_NOTIFY_WORKER_FAILED_JOBS:', result.failed_jobs)
    }
  } catch (error) {
    lastErrorCode = /^PRE_ORDER_[A-Z0-9_]+$/.test(String(error?.code || ''))
      ? error.code : 'PRE_ORDER_NOTIFY_WORKER_UNEXPECTED'
    console.error('PRE_ORDER_NOTIFY_WORKER_CYCLE_FAILED:', lastErrorCode)
    delay = AUTHOR_PREORDER_NOTIFY_ERROR_INTERVAL_MS
  } finally {
    running = false
    schedule(delay)
  }
}

export function startAuthorPreOrderNotificationWorker() {
  if (started) return getAuthorPreOrderNotificationWorkerState()
  if (!authorPreOrderNotificationWorkerEnabled()) return getAuthorPreOrderNotificationWorkerState()
  started = true
  schedule(AUTHOR_PREORDER_NOTIFY_INTERVAL_MS)
  return getAuthorPreOrderNotificationWorkerState()
}

export function stopAuthorPreOrderNotificationWorker() {
  started = false
  if (timer) clearTimeout(timer)
  timer = null
  nextRunAt = null
  return getAuthorPreOrderNotificationWorkerState()
}

export function getAuthorPreOrderNotificationWorkerState() {
  return {
    enabled: authorPreOrderNotificationWorkerEnabled(),
    started,
    running,
    next_run_at: nextRunAt,
    last_run_at: lastRunAt,
    last_success_at: lastSuccessAt,
    last_error_code: lastErrorCode,
    last_result: lastResult,
    interval_seconds: AUTHOR_PREORDER_NOTIFY_INTERVAL_MS / 1000,
    batch_limit: AUTHOR_PREORDER_NOTIFY_BATCH_LIMIT,
  }
}
