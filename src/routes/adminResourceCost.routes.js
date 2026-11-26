import express from 'express'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { resourceCostCalendarPeriod } from '../services/resourceCostSummary.service.js'
import { getResourceCostReport } from '../services/resourceCostReportData.service.js'
import { createResourceCostDownload } from '../services/resourceCostReportExport.service.js'
import { getResourceCostHealth } from '../services/resourceCostHealth.service.js'
import { getResourceCostYesterdaySnapshot } from '../services/resourceCostYesterdaySnapshot.service.js'
import { getResourceCostOverview } from '../services/resourceCostOverview.service.js'
import { evaluateHeavyJobAdmission } from '../services/memoryGuard.service.js'

const router = express.Router()
const DAY_MS = 24 * 60 * 60 * 1000
const QUERY_BUCKET_MS = 15 * 60 * 1000
const CACHE_MS = 15 * 60 * 1000
const MAX_CACHED_APPLICATION_ROWS = 3000
const RETRY_AFTER_SECONDS = 30
const BUILD_ESTIMATE_MB = 120
const SUMMARY_ESTIMATE_MB = 32
const DOWNLOAD_ESTIMATE_MB = 64
const HEALTH_CACHE_MS = 5 * 60 * 1000
let reportCache = null
let reportCacheTimer = null
let reportActive = false
let healthCache = null
const allowedModes = new Set(['today', 'week', 'month', 'last7', 'last30', 'custom'])
const allowedFormats = new Set([
  'full-zip', 'daily-csv', 'weekly-csv', 'monthly-csv',
  'provider-csv', 'upload-csv', 'api-csv', 'route-csv', 'evidence-json',
])

const resourceCostGuard = createRateLimit({
  key: 'admin-resource-cost',
  windowMs: 60 * 1000,
  max: 20,
  message: 'Too many Resource & Cost requests. Please try again shortly.',
})
const viewResourceCost = requireAdminPermission('system_control.view')

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

function clearReportCache() {
  if (reportCacheTimer) clearTimeout(reportCacheTimer)
  reportCacheTimer = null
  reportCache = null
}

function busyError(reason) {
  const error = new Error('Resource & Cost report is temporarily busy. Please retry shortly.')
  error.code = 'RESOURCE_COST_BUSY'
  error.reason = reason
  return error
}

function ensureReportMemory(estimatedJobMb) {
  const admission = evaluateHeavyJobAdmission({ jobType: 'resource_cost_report', estimatedJobMb })
  if (admission.warning || !admission.allowed) clearReportCache()
  if (!admission.allowed || admission.active_manga_upload) {
    const reason = admission.active_manga_upload ? 'manga_upload_active' : admission.reason
    console.warn('RESOURCE_COST_MEMORY_DEFERRED:', JSON.stringify({
      reason,
      container_total_mb: admission.container_total_mb,
      container_limit_mb: admission.container_limit_mb,
      projected_mb: admission.projected_mb,
    }))
    throw busyError(reason)
  }
  return admission
}

async function withHeavyReport(res, work) {
  if (reportActive) throw busyError('report_in_progress')
  if (res.destroyed) return
  reportActive = true
  let workDone = false
  let responseDone = false
  const releaseIfDone = () => {
    if (!workDone || !responseDone) return
    res.off('finish', onResponseDone)
    res.off('close', onResponseDone)
    reportActive = false
  }
  const onResponseDone = () => {
    responseDone = true
    releaseIfDone()
  }
  res.once('finish', onResponseDone)
  res.once('close', onResponseDone)
  try {
    return await work()
  } finally {
    workDone = true
    if (res.writableFinished || res.destroyed) responseDone = true
    releaseIfDone()
  }
}

async function reportFor(query, now = new Date()) {
  const period = parsePeriod(query, now)
  const key = `${period.mode}|${period.from}|${period.to}`
  const admission = ensureReportMemory(SUMMARY_ESTIMATE_MB)
  if (reportCache?.key === key && reportCache.expiresAt > Date.now()) {
    return { report: reportCache.report, cached: true, ttlSeconds: Math.ceil((reportCache.expiresAt - Date.now()) / 1000) }
  }
  clearReportCache()
  ensureReportMemory(BUILD_ESTIMATE_MB)
  const report = await getResourceCostReport({ from: period.from, to: period.to, asOf: now })
  const after = ensureReportMemory(SUMMARY_ESTIMATE_MB)
  if (!admission.warning && !after.warning &&
      Array.isArray(report.applicationHourlyRows) && report.applicationHourlyRows.length <= MAX_CACHED_APPLICATION_ROWS) {
    reportCache = { key, report, expiresAt: Date.now() + CACHE_MS }
    reportCacheTimer = setTimeout(clearReportCache, CACHE_MS)
    reportCacheTimer.unref?.()
  }
  return { report, cached: false, ttlSeconds: reportCache ? CACHE_MS / 1000 : 0 }
}

function respondError(res, error) {
  if (res.destroyed || res.writableEnded || res.headersSent) return
  if (error?.code === 'RESOURCE_COST_BUSY') {
    res.set('Retry-After', String(RETRY_AFTER_SECONDS))
    return res.status(503).json({
      ok: false,
      code: error.code,
      reason: error.reason,
      message: error.message,
      retry_after_seconds: RETRY_AFTER_SECONDS,
    })
  }
  const invalid = error instanceof RangeError || error instanceof TypeError
  if (!invalid) console.error('RESOURCE_COST_REPORT_ERROR:', error?.message || error)
  return res.status(invalid ? 400 : 503).json({
    ok: false,
    message: invalid
      ? String(error?.message || 'Invalid Resource & Cost request.')
      : 'Resource & Cost data is unavailable. Check stored provider records and database setup.',
  })
}

router.get('/health', resourceCostGuard, viewResourceCost, async (req, res) => {
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

router.get('/yesterday-snapshot', resourceCostGuard, viewResourceCost, async (req, res) => {
  try {
    const snapshot = await getResourceCostYesterdaySnapshot()
    return res.status(200).json({ ok: true, snapshot })
  } catch (error) {
    return respondError(res, error)
  }
})

router.get('/overview', resourceCostGuard, viewResourceCost, async (req, res) => {
  try {
    const period = String(req.query?.period || 'last7').trim().toLowerCase()
    const overview = await getResourceCostOverview({
      period,
      ...(period === 'custom' ? { from: req.query?.from, to: req.query?.to } : {}),
    })
    return res.status(200).json({ ok: true, overview })
  } catch (error) {
    return respondError(res, error)
  }
})

router.get('/summary', resourceCostGuard, viewResourceCost, async (req, res) => {
  try {
    return await withHeavyReport(res, async () => {
      const result = await reportFor(req.query)
      if (res.destroyed) return
      ensureReportMemory(SUMMARY_ESTIMATE_MB)
      return res.status(200).json({
        ok: true,
        report: result.report,
        cache: { reused: result.cached, ttl_seconds: reportCache ? result.ttlSeconds : 0 },
      })
    })
  } catch (error) {
    return respondError(res, error)
  }
})

router.get('/download', resourceCostGuard, viewResourceCost, async (req, res) => {
  try {
    const format = String(req.query?.format || 'full-zip').trim().toLowerCase()
    if (!allowedFormats.has(format)) throw new RangeError('Unsupported report format.')
    return await withHeavyReport(res, async () => {
      const { report } = await reportFor(req.query)
      if (res.destroyed) return
      ensureReportMemory(DOWNLOAD_ESTIMATE_MB)
      const file = createResourceCostDownload(report, format)
      const filename = String(file.filename || 'shadow-resource-cost.zip').replace(/[^a-zA-Z0-9._-]/g, '_')
      res.set('Content-Type', file.contentType)
      res.set('Content-Disposition', `attachment; filename="${filename}"`)
      res.set('Content-Length', String(file.body.length))
      return res.status(200).send(file.body)
    })
  } catch (error) {
    return respondError(res, error)
  }
})

export default router
