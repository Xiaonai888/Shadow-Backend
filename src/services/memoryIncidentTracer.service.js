import { randomUUID } from 'node:crypto'
import { getMemoryGuardSnapshot } from './memoryGuard.service.js'

const MB = 1024 * 1024
const SAMPLE_INTERVAL_MS = 2000
const HIGH_REPEAT_MS = 30000
const RECENT_WINDOW_MS = 2 * 60 * 1000
const MAX_RECENT_REQUESTS = 80
const MAX_LOG_ACTIVE = 12
const MAX_LOG_RECENT = 16
const REQUEST_DELTA_LOG_MB = 16
const LARGE_REQUEST_BYTES = 5 * 1024 * 1024
const LEVELS_MB = [250, 300, 350, 400, 440, 470]

const activeRequests = new Map()
const recentRequests = []

let monitorStarted = false
let currentLevelMb = 0
let lastHighLogAt = 0
let lastLoggedTotalMb = 0

function mb(bytes) {
  return Number((Number(bytes || 0) / MB).toFixed(1))
}

function processSnapshot() {
  const memory = process.memoryUsage()

  return {
    rss_mb: mb(memory.rss),
    heap_used_mb: mb(memory.heapUsed),
    heap_total_mb: mb(memory.heapTotal),
    external_mb: mb(memory.external),
    array_buffers_mb: mb(memory.arrayBuffers),
  }
}

function safePath(req) {
  const raw = String(req.originalUrl || req.url || req.path || '/')
  return raw.split('?')[0].slice(0, 240)
}

function contentLength(req) {
  const value = Number(req.headers['content-length'] || 0)
  return Number.isFinite(value) && value > 0 ? value : 0
}

function contentType(req) {
  return String(req.headers['content-type'] || '')
    .split(';')[0]
    .trim()
    .slice(0, 120)
}

function currentLevel(totalMb) {
  let level = 0

  for (const threshold of LEVELS_MB) {
    if (totalMb >= threshold) {
      level = threshold
    }
  }

  return level
}

function compactActive(now = Date.now()) {
  return [...activeRequests.values()]
    .map((item) => ({
      request_id: item.request_id,
      method: item.method,
      path: item.path,
      age_ms: Math.max(0, now - item.started_at_ms),
      content_length: item.content_length,
      content_type: item.content_type,
      rss_start_mb: item.rss_start_mb,
    }))
    .sort((a, b) => {
      if (b.content_length !== a.content_length) {
        return b.content_length - a.content_length
      }

      return b.age_ms - a.age_ms
    })
    .slice(0, MAX_LOG_ACTIVE)
}

function trimRecent(now = Date.now()) {
  while (
    recentRequests.length &&
    (
      recentRequests.length > MAX_RECENT_REQUESTS ||
      now - recentRequests[0].finished_at_ms > RECENT_WINDOW_MS
    )
  ) {
    recentRequests.shift()
  }
}

function recentCandidates(now = Date.now()) {
  trimRecent(now)

  return [...recentRequests]
    .filter((item) => now - item.finished_at_ms <= RECENT_WINDOW_MS)
    .sort((a, b) => {
      const aScore =
        Math.max(0, a.rss_delta_mb) * 10 +
        a.content_length / MB
      const bScore =
        Math.max(0, b.rss_delta_mb) * 10 +
        b.content_length / MB

      return bScore - aScore
    })
    .slice(0, MAX_LOG_RECENT)
    .map((item) => ({
      request_id: item.request_id,
      method: item.method,
      path: item.path,
      status: item.status,
      duration_ms: item.duration_ms,
      content_length: item.content_length,
      content_type: item.content_type,
      rss_before_mb: item.rss_before_mb,
      rss_after_mb: item.rss_after_mb,
      rss_delta_mb: item.rss_delta_mb,
      seconds_ago: Number(
        ((now - item.finished_at_ms) / 1000).toFixed(1)
      ),
    }))
}

function candidateSource(active, recent) {
  const heavyActive = active.find(
    (item) =>
      item.content_length >= 1024 * 1024 ||
      item.method !== 'GET'
  )

  if (heavyActive) {
    return {
      kind: 'active_request',
      request_id: heavyActive.request_id,
      method: heavyActive.method,
      path: heavyActive.path,
    }
  }

  const heavyRecent = recent.find(
    (item) =>
      item.rss_delta_mb >= 8 ||
      item.content_length >= 1024 * 1024
  )

  if (heavyRecent) {
    return {
      kind: 'recent_request_or_native_retention',
      request_id: heavyRecent.request_id,
      method: heavyRecent.method,
      path: heavyRecent.path,
    }
  }

  return {
    kind: 'background_or_native_memory',
  }
}

function emitIncident(reason, snapshot) {
  const now = Date.now()
  const active = compactActive(now)
  const recent = recentCandidates(now)

  console.warn(
    'MEMORY_INCIDENT',
    JSON.stringify({
      reason,
      sampled_at: new Date(now).toISOString(),
      pid: process.pid,
      uptime_seconds: Number(process.uptime().toFixed(1)),
      container_total_mb: snapshot.container_total_mb,
      container_limit_mb: snapshot.container_limit_mb,
      available_mb: snapshot.available_mb,
      usage_percent: snapshot.usage_percent,
      warning: snapshot.warning,
      blocked: snapshot.blocked,
      critical: snapshot.critical,
      emergency: snapshot.emergency,
      process: processSnapshot(),
      candidate_source: candidateSource(active, recent),
      active_request_count: activeRequests.size,
      active_requests: active,
      recent_requests: recent,
    })
  )

  lastHighLogAt = now
  lastLoggedTotalMb = snapshot.container_total_mb
}

export function memoryIncidentTracer(req, res, next) {
  const requestId = randomUUID().slice(0, 12)
  const startedAtMs = Date.now()
  const before = process.memoryUsage()

  const item = {
    request_id: requestId,
    method: String(req.method || 'UNKNOWN'),
    path: safePath(req),
    started_at_ms: startedAtMs,
    content_length: contentLength(req),
    content_type: contentType(req),
    rss_start_mb: mb(before.rss),
  }

  activeRequests.set(requestId, item)

  let finished = false

  const complete = () => {
    if (finished) return
    finished = true

    activeRequests.delete(requestId)

    const after = process.memoryUsage()
    const finishedAtMs = Date.now()
    const rssDeltaMb = mb(after.rss - before.rss)

    const record = {
      request_id: requestId,
      method: item.method,
      path: item.path,
      status: Number(res.statusCode || 0),
      duration_ms: finishedAtMs - startedAtMs,
      content_length: item.content_length,
      content_type: item.content_type,
      rss_before_mb: mb(before.rss),
      rss_after_mb: mb(after.rss),
      rss_delta_mb: rssDeltaMb,
      finished_at_ms: finishedAtMs,
    }

    recentRequests.push(record)
    trimRecent(finishedAtMs)

    if (
      rssDeltaMb >= REQUEST_DELTA_LOG_MB ||
      item.content_length >= LARGE_REQUEST_BYTES
    ) {
      const snapshot = getMemoryGuardSnapshot()

      console.warn(
        'MEMORY_REQUEST_SUSPECT',
        JSON.stringify({
          ...record,
          container_total_mb: snapshot.container_total_mb,
          container_limit_mb: snapshot.container_limit_mb,
          available_mb: snapshot.available_mb,
          process: processSnapshot(),
        })
      )
    }

    res.off('finish', complete)
    res.off('close', complete)
  }

  res.once('finish', complete)
  res.once('close', complete)

  next()
}

export function startMemoryIncidentMonitor() {
  if (monitorStarted) return

  monitorStarted = true

  console.log(
    'MEMORY_INCIDENT_TRACER: started',
    JSON.stringify({
      sample_interval_ms: SAMPLE_INTERVAL_MS,
      levels_mb: LEVELS_MB,
      recent_window_ms: RECENT_WINDOW_MS,
    })
  )

  const timer = setInterval(() => {
    const snapshot = getMemoryGuardSnapshot()
    const level = currentLevel(snapshot.container_total_mb)
    const now = Date.now()

    if (level !== currentLevelMb) {
      const direction =
        level > currentLevelMb
          ? 'threshold_up'
          : 'threshold_down'

      currentLevelMb = level

      if (level >= 250 || direction === 'threshold_down') {
        emitIncident(
          `${direction}:${level}`,
          snapshot
        )
      }

      return
    }

    if (
      snapshot.container_total_mb >= 300 &&
      (
        now - lastHighLogAt >= HIGH_REPEAT_MS ||
        snapshot.container_total_mb - lastLoggedTotalMb >= 20
      )
    ) {
      emitIncident('high_memory_repeat', snapshot)
    }
  }, SAMPLE_INTERVAL_MS)

  timer.unref?.()

  process.on('uncaughtExceptionMonitor', (error, origin) => {
    const snapshot = getMemoryGuardSnapshot()
    const active = compactActive()
    const recent = recentCandidates()

    console.error(
      'MEMORY_INCIDENT_CRASH_CONTEXT',
      JSON.stringify({
        origin,
        error_name: String(error?.name || 'Error'),
        error_message: String(error?.message || error || 'unknown'),
        container_total_mb: snapshot.container_total_mb,
        container_limit_mb: snapshot.container_limit_mb,
        process: processSnapshot(),
        candidate_source: candidateSource(active, recent),
        active_requests: active,
        recent_requests: recent,
      })
    )
  })
}
