import express from 'express'
import { rateLimit } from 'express-rate-limit'

const router = express.Router()
const HOUR_MS = 60 * 60 * 1000
const HISTORY_HOURS = 96
const WINDOWS = new Map()
const STARTED_AT = new Date().toISOString()
const VALID_SOURCES = new Set(['CLOUDFLARE_R2', 'OTHER_EXTERNAL_UNVERIFIED', 'SAME_ORIGIN'])
const VALID_PAGES = new Set(['HOME', 'MANGA', 'READ', 'STORY', 'AUTHOR', 'CHAT', 'MINE', 'OTHER'])
const FIELDS = ['timed', 'unavailable', 'slow_1500', 'slow_3000', 'load_errors', 'sum_ms']
let acceptedReports = 0

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 24,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, code: 'IMAGE_DIAGNOSTIC_RATE_LIMITED' },
})

function isPermittedOrigin(origin) {
  if (!origin) return false
  const allowed = new Set([
    'https://shadowerabook.site',
    'https://www.shadowerabook.site',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
    process.env.FRONTEND_URL,
  ].filter(Boolean))
  return allowed.has(origin)
}

function boundedInteger(value, limit) {
  return Number.isSafeInteger(value) && value >= 0 && value <= limit
}

function validGroup(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item) ||
      !VALID_SOURCES.has(item.source) || !VALID_PAGES.has(item.page)) return false
  for (const field of FIELDS) {
    if (!boundedInteger(item[field], field === 'sum_ms' ? 24_000_000 : 400)) return false
  }
  if (!boundedInteger(item.max_ms, 60000)) return false
  if (item.slow_3000 > item.slow_1500 || item.slow_1500 > item.timed) return false
  if (item.timed === 0 && (item.sum_ms !== 0 || item.max_ms !== 0)) return false
  if (item.timed > 0 && (item.max_ms < 1 || item.sum_ms < item.max_ms || item.sum_ms > item.timed * 60000)) return false
  return item.timed + item.unavailable + item.load_errors > 0
}

function pruneWindows(now = Date.now()) {
  const cutoff = Math.floor(now / HOUR_MS) * HOUR_MS - (HISTORY_HOURS - 1) * HOUR_MS
  for (const key of WINDOWS.keys()) if (key < cutoff) WINDOWS.delete(key)
  while (WINDOWS.size > HISTORY_HOURS) WINDOWS.delete(WINDOWS.keys().next().value)
}

function newMetrics(source = '', page = '') {
  return { source, page, timed: 0, unavailable: 0, slow_1500: 0,
    slow_3000: 0, load_errors: 0, sum_ms: 0, max_ms: 0 }
}

function merge(target, item) {
  for (const field of FIELDS) target[field] += item[field]
  target.max_ms = Math.max(target.max_ms, item.max_ms)
}

function recordGroups(groups) {
  const now = Date.now()
  pruneWindows(now)
  const hour = Math.floor(now / HOUR_MS) * HOUR_MS
  const window = WINDOWS.get(hour) || { reports: 0, rows: new Map() }
  window.reports += 1
  for (const item of groups) {
    const key = `${item.source}:${item.page}`
    const row = window.rows.get(key) || newMetrics(item.source, item.page)
    merge(row, item)
    window.rows.set(key, row)
  }
  WINDOWS.set(hour, window)
  acceptedReports += 1
}

function summarize(hours) {
  pruneWindows()
  const start = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - (hours - 1) * HOUR_MS
  const sources = new Map()
  const hourly = []
  const total = newMetrics()
  let reports = 0
  for (const [hour, window] of WINDOWS) {
    if (hour < start) continue
    reports += window.reports
    const current = newMetrics()
    for (const item of window.rows.values()) {
      merge(current, item)
      merge(total, item)
      const row = sources.get(item.source) || newMetrics(item.source)
      merge(row, item)
      sources.set(item.source, row)
    }
    hourly.push({ hour: new Date(hour).toISOString(), ...current, reports: window.reports })
  }
  const format = (item) => ({
    ...item,
    observed_image_resources: item.timed + item.unavailable,
    observed_average_ms: item.timed ? Math.round(item.sum_ms / item.timed) : null,
  })
  return {
    hours,
    reports,
    totals: format(total),
    sources: [...sources.values()].map(format).sort((a, b) => b.load_errors - a.load_errors || b.slow_3000 - a.slow_3000),
    hourly: hourly.sort((a, b) => a.hour.localeCompare(b.hour)).slice(-hours).map(format),
  }
}

export function getImageLoadDiagnosticsSnapshot() {
  return {
    generated_at: new Date().toISOString(),
    started_at: STARTED_AT,
    status: 'CLIENT_REPORTED_SAMPLED_EVIDENCE',
    sample_rate: 0.2,
    accepted_reports_since_start: acceptedReports,
    recent_24h: summarize(24),
    recent_96h: summarize(96),
    limitations: [
      'Only sampled browsers are measured. These are not all readers or all images.',
      'PerformanceResourceTiming measures browser-observed resource duration, not Cloudflare server processing time.',
      'Some cross-origin resources have unavailable timing due to browser privacy rules.',
      'R2 custom domains are classified as unverified external unless VITE_R2_PUBLIC_URL is configured in Web.',
      'Image load errors are counted separately from resource timings and may overlap.',
      'Data is held in Render memory for at most 96 hours and is reset on Backend restart.',
      'Client reports are unverified telemetry. Correlate with provider logs before assigning root cause.',
    ],
  }
}

router.post('/', limiter, express.text({ type: 'text/plain', limit: '4kb' }), (req, res) => {
  res.set('Cache-Control', 'no-store')
  if (!isPermittedOrigin(req.get('origin'))) {
    return res.status(403).json({ ok: false, code: 'IMAGE_DIAGNOSTIC_ORIGIN_DENIED' })
  }
  if (typeof req.body !== 'string' || req.body.length > 3800) {
    return res.status(400).json({ ok: false, code: 'IMAGE_DIAGNOSTIC_INVALID_PAYLOAD' })
  }
  let payload
  try { payload = JSON.parse(req.body) } catch {
    return res.status(400).json({ ok: false, code: 'IMAGE_DIAGNOSTIC_INVALID_JSON' })
  }
  if (payload?.version !== 1 || !Array.isArray(payload.groups) ||
      !payload.groups.length || payload.groups.length > 18 ||
      !payload.groups.every(validGroup)) {
    return res.status(400).json({ ok: false, code: 'IMAGE_DIAGNOSTIC_INVALID_GROUPS' })
  }
  recordGroups(payload.groups)
  return res.status(204).end()
})

export default router
