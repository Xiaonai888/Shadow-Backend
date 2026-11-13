import express from 'express'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { resourceCostCalendarPeriod } from '../services/resourceCostSummary.service.js'
import { getResourceCostReport } from '../services/resourceCostReportData.service.js'
import { createResourceCostDownload } from '../services/resourceCostReportExport.service.js'
import { getResourceCostHealth } from '../services/resourceCostHealth.service.js'

const router = express.Router()
const DAY_MS = 24 * 60 * 60 * 1000
const QUERY_BUCKET_MS = 15 * 60 * 1000
const CACHE_MS = 15 * 60 * 1000
const MAX_CACHE_ENTRIES = 12
const HEALTH_CACHE_MS = 5 * 60 * 1000
const reportCache = new Map()
let healthCache = null
const allowedModes = new Set(['today', 'week', 'month', 'last7', 'last30', 'custom'])
const allowedFormats = new Set([
  'full-zip', 'daily-csv', 'weekly-csv', 'monthly-csv',
  'provider-csv', 'upload-csv', 'api-csv', 'evidence-json',
])

router.use(createRateLimit({
  key: 'admin-resource-cost',
  windowMs: 60 * 1000,
  max: 20,
  message: 'Too many Resource & Cost requests. Please try again shortly.',
}))
router.use(requireAdminPermission('system_control.view'))
router.use((req, res, next) => {
  res.set('Cache-Control', 'private, no-store')
  next()
})

function parsePeriod(query, now) {
  const mode = String(query?.period || 'today').trim().toLowerCase()
  if (!allowedModes.has(mode)) throw new RangeError('Unsupported period.')
  if (mode === 'custom') {
    const from = String(query?.from || '').trim()
    const to = String(query?.to || '').trim()
    if (!/^\d{4}-\d{2}-\d{2}T/.test(from) || !/^\d{4}-\d{2}-\d{2}T/.test(to)) {
      throw new RangeError('Custom range requires ISO start and end date-times.')
    }
    return { mode, from, to }
  }
  if (mode === 'last7' || mode === 'last30') {
    const end = Math.floor(now.getTime() / QUERY_BUCKET_MS) * QUERY_BUCKET_MS
    return {
      mode,
      from: new Date(end - (mode === 'last7' ? 7 : 30) * DAY_MS).toISOString(),
      to: new Date(end).toISOString(),
    }
  }
  const range = resourceCostCalendarPeriod(now, mode === 'today' ? 'day' : mode)
  return { mode, ...range }
}

async function reportFor(query, now = new Date()) {
  const period = parsePeriod(query, now)
  const key = `${period.mode}|${period.from}|${period.to}`
  const time = Date.now()
  const stored = reportCache.get(key)
  if (stored && stored.expiresAt > time) {
    return { report: await stored.pending, cached: true }
  }
  if (stored) reportCache.delete(key)
  const entry = {
    expiresAt: time + CACHE_MS,
    pending: getResourceCostReport({ from: period.from, to: period.to, asOf: now }),
  }
  reportCache.set(key, entry)
  while (reportCache.size > MAX_CACHE_ENTRIES) {
    reportCache.delete(reportCache.keys().next().value)
  }
  try {
    return { report: await entry.pending, cached: false }
  } catch (error) {
    if (reportCache.get(key) === entry) reportCache.delete(key)
    throw error
  }
}

function respondError(res, error) {
  const invalid = error instanceof RangeError || error instanceof TypeError
  if (!invalid) console.error('RESOURCE_COST_REPORT_ERROR:', error?.message || error)
  return res.status(invalid ? 400 : 503).json({
    ok: false,
    message: invalid
      ? String(error?.message || 'Invalid Resource & Cost request.')
      : 'Resource & Cost data is unavailable. Check stored provider records and database setup.',
  })
}

router.get('/health', async (req, res) => {
  try {
    const now = Date.now()
    if (!healthCache || healthCache.expiresAt <= now) {
      healthCache = { expiresAt: now + HEALTH_CACHE_MS, pending: getResourceCostHealth() }
    }
    let result
    try {
      result = await healthCache.pending
    } catch (error) {
      healthCache = null
      throw error
    }
    return res.status(200).json({ ok: true, health: result })
  } catch (error) {
    return respondError(res, error)
  }
})

router.get('/summary', async (req, res) => {
  try {
    const result = await reportFor(req.query)
    return res.status(200).json({
      ok: true,
      report: result.report,
      cache: { reused: result.cached, ttl_seconds: CACHE_MS / 1000 },
    })
  } catch (error) {
    return respondError(res, error)
  }
})

router.get('/download', async (req, res) => {
  try {
    const format = String(req.query?.format || 'full-zip').trim().toLowerCase()
    if (!allowedFormats.has(format)) throw new RangeError('Unsupported report format.')
    const { report } = await reportFor(req.query)
    const file = createResourceCostDownload(report, format)
    const filename = String(file.filename || 'shadow-resource-cost.zip').replace(/[^a-zA-Z0-9._-]/g, '_')
    res.set('Content-Type', file.contentType)
    res.set('Content-Disposition', `attachment; filename="${filename}"`)
    res.set('Content-Length', String(file.body.length))
    return res.status(200).send(file.body)
  } catch (error) {
    return respondError(res, error)
  }
})

export default router
