import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { heartbeatReaderPresence } from '../controllers/readerPresence.controller.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

const readerPresenceSafetyLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 2000,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'READER_PRESENCE_SAFETY_LIMIT',
    message: 'Too many presence requests. Please retry shortly.',
  },
})

const readerPresenceRateLimit =
  createRateLimit({
    key: 'reader-presence',
    windowMs: 60 * 1000,
    max: 120,
    message:
      'Too many presence updates. Please wait before trying again.',
    identity: (req) =>
      req.user?.user_id,
  })

// Read-only, aggregated heartbeat diagnostics. No database writes, no throttling changes.
// In-memory reader keys expire at the end of each 15-minute window and are never logged.
const PRESENCE_DIAGNOSTIC_WINDOW_MS = 15 * 60 * 1000
const PRESENCE_MAX_TRACKED_READERS = 5000
const PRESENCE_REPEAT_THRESHOLD = 12
const PRESENCE_REQUEST_SPIKE_THRESHOLD = 150
const PRESENCE_ERROR_ALERT_THRESHOLD = 3

function newPresenceDiagnosticWindow(now = Date.now()) {
  const startedAt = Math.floor(now / PRESENCE_DIAGNOSTIC_WINDOW_MS) * PRESENCE_DIAGNOSTIC_WINDOW_MS
  return {
    start: startedAt,
    end: startedAt + PRESENCE_DIAGNOSTIC_WINDOW_MS,
    requests: 0,
    successes: 0,
    unauthorized: 0,
    rate_limited: 0,
    other_4xx: 0,
    errors_5xx: 0,
    aborted: 0,
    other_statuses: 0,
    unattributed_requests: 0,
    untracked_reader_requests: 0,
    readers: new Map(),
  }
}

let presenceDiagnosticWindow = newPresenceDiagnosticWindow()

function flushPresenceDiagnosticWindow(now = Date.now()) {
  const window = presenceDiagnosticWindow
  // Always rotate the window, including empty ones, to release per-reader counts.
  presenceDiagnosticWindow = newPresenceDiagnosticWindow(now)
  if (!window.requests) return

  let frequentReaders = 0
  let peakReaderRequests = 0
  for (const count of window.readers.values()) {
    if (count >= PRESENCE_REPEAT_THRESHOLD) frequentReaders += 1
    if (count > peakReaderRequests) peakReaderRequests = count
  }

  const alertReasons = []
  if (window.requests >= PRESENCE_REQUEST_SPIKE_THRESHOLD) alertReasons.push('high_request_volume')
  if (window.errors_5xx >= PRESENCE_ERROR_ALERT_THRESHOLD) alertReasons.push('server_errors')
  if (window.rate_limited >= PRESENCE_ERROR_ALERT_THRESHOLD) alertReasons.push('rate_limited')
  if (window.aborted >= PRESENCE_ERROR_ALERT_THRESHOLD) alertReasons.push('aborted_requests')
  if (frequentReaders > 0) alertReasons.push('frequent_reader_requests')

  const summary = {
    window_start: new Date(window.start).toISOString(),
    window_end: new Date(window.end).toISOString(),
    requests: window.requests,
    success_2xx: window.successes,
    unauthorized_401_403: window.unauthorized,
    rate_limited_429: window.rate_limited,
    other_4xx: window.other_4xx,
    errors_5xx: window.errors_5xx,
    aborted: window.aborted,
    other_statuses: window.other_statuses,
    unrecognized_reader_requests: window.unattributed_requests,
    tracked_unique_readers: window.readers.size,
    untracked_reader_requests: window.untracked_reader_requests,
    frequent_readers_12_plus: frequentReaders,
    max_requests_per_reader: peakReaderRequests,
    alert_reasons: alertReasons,
    // Counters describe this Render process, not global traffic or all replicas.
    scope: 'single_backend_process',
  }
  const log = alertReasons.length ? console.warn : console.info
  log('READER_PRESENCE_TRAFFIC_15M', JSON.stringify(summary))
}

function recordPresenceDiagnostic(req, res, aborted) {
  try {
    const now = Date.now()
    if (now >= presenceDiagnosticWindow.end) flushPresenceDiagnosticWindow(now)
    const window = presenceDiagnosticWindow
    window.requests += 1

    if (aborted) {
      window.aborted += 1
    } else {
      const status = Number(res.statusCode || 0)
      if (status >= 200 && status < 300) window.successes += 1
      else if (status === 401 || status === 403) window.unauthorized += 1
      else if (status === 429) window.rate_limited += 1
      else if (status >= 400 && status < 500) window.other_4xx += 1
      else if (status >= 500) window.errors_5xx += 1
      else window.other_statuses += 1
    }

    // req.user is populated by requireUser for authenticated requests.
    const readerId = String(req.user?.user_id || '')
    if (!readerId) {
      window.unattributed_requests += 1
    } else if (window.readers.has(readerId)) {
      window.readers.set(readerId, window.readers.get(readerId) + 1)
    } else if (window.readers.size < PRESENCE_MAX_TRACKED_READERS) {
      window.readers.set(readerId, 1)
    } else {
      window.untracked_reader_requests += 1
    }
  } catch (error) {
    // Diagnostics must never fail a heartbeat or change its status.
    console.warn('READER_PRESENCE_DIAGNOSTIC_ERROR', String(error?.message || error).slice(0, 120))
  }
}

function monitorReaderPresenceTraffic(req, res, next) {
  let recorded = false
  function record(aborted) {
    if (recorded) return
    recorded = true
    recordPresenceDiagnostic(req, res, aborted)
  }
  res.once('finish', () => record(false))
  res.once('close', () => record(true))
  next()
}

const presenceDiagnosticTimer = setInterval(() => {
  if (Date.now() >= presenceDiagnosticWindow.end) {
    flushPresenceDiagnosticWindow()
  }
}, 60 * 1000)
presenceDiagnosticTimer.unref?.()

router.post(
  '/heartbeat',
  monitorReaderPresenceTraffic,
  readerPresenceSafetyLimit,
  requireUser,
  readerPresenceRateLimit,
  heartbeatReaderPresence
)

export default router
