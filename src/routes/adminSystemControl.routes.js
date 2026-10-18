import { getRuntimeMemoryInspector } from '../services/runtimeMemoryInspector.service.js'
import express from 'express'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import { getSystemUsageCurrentSnapshot } from '../services/systemUsageMonitor.service.js'
import { getSystemUsageAnomalySnapshot } from '../services/systemUsageAnomaly.service.js'
import { getSystemUsageRegressionState } from '../services/systemUsageRegression.service.js'
import { getRecentRequestEvidence, getGuestRequestSnapshot, getHistoricalErrorEvidence, getPageRequestSnapshot } from '../services/trafficDiagnostic.service.js'
import {
  listSystemUsageIncidents,
  getSystemUsageIncident,
  applySystemUsageIncidentFix,
  verifySystemUsageIncident,
  resolveSystemUsageIncident,
  archiveSystemUsageIncident,
} from '../services/systemUsageIncident.service.js'
import {
  getSystemUsageHistory,
  getSystemUsageProviderState,
  refreshSystemUsageProviders,
} from '../services/systemUsagePersistence.service.js'
import { generateSystemUsageReport } from '../services/systemUsageReport.service.js'

const router = express.Router()
const viewSystemControl = requireAdminPermission('system_control.view')
const manageSystemControl = requireAdminPermission('system_control.manage')

const snapshotGuard = createRateLimit({
  key: 'admin-system-control-snapshot',
  windowMs: 60 * 1000,
  max: 30,
  message: 'Too many System Control snapshot requests. Please wait before refreshing again.',
})

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store')
  next()
})

const RENDER_MONTHLY_CACHE_MS = 15 * 60 * 1000
let renderMonthlyCache = { key: '', until: 0, value: null, pending: null }

async function loadRenderMonthlySummary() {
  const now = new Date()
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  const key = periodStart.toISOString()

  if (renderMonthlyCache.key !== key) {
    renderMonthlyCache = { key, until: 0, value: null, pending: null }
  }
  if (renderMonthlyCache.value && Date.now() < renderMonthlyCache.until) {
    return renderMonthlyCache.value
  }
  if (renderMonthlyCache.pending) return renderMonthlyCache.pending

  const pending = (async () => {
    const { supabase } = await import('../config/supabase.js')
    const { data, error } = await supabase.rpc('get_render_bandwidth_summary', {
      p_start: periodStart.toISOString(),
      p_end: periodEnd.toISOString(),
    })
    if (error) throw error
    if (!data || typeof data !== 'object') {
      throw new Error('Render bandwidth summary is unavailable.')
    }

    const configuredIds = [
      process.env.RENDER_SERVICE_ID,
      process.env.SYSTEM_RENDER_SERVICE_ID,
      ...(process.env.RENDER_SERVICE_IDS || '').split(/[\s,;]+/),
    ].map((item) => String(item || '').trim()).filter((item) => /^srv-[a-z0-9-]+$/i.test(item))
    const serviceIds = [...new Set(configuredIds)]
    const includedGbRaw = Number(process.env.RENDER_MONTHLY_INCLUDED_GB || 5)
    const includedGb = Number.isFinite(includedGbRaw) && includedGbRaw >= 0
      ? includedGbRaw : 5
    const includedBytes = includedGb * 1000 ** 3
    const totalBytes = Math.max(0, Number(data.total_bytes) || 0)
    const expectedUntil = Math.min(periodEnd.getTime(), Date.now() - 2 * 60 * 60 * 1000)
    const expectedHours = Math.max(0, Math.floor((expectedUntil - periodStart.getTime()) / 3600000))
    const serviceCount = serviceIds.length || Math.max(0, Number(data.tracked_services) || 0)
    const expectedServiceHours = expectedHours * serviceCount
    const recordedServiceHours = Math.max(0, Number(data.recorded_service_hours) || 0)
    const coveragePercent = expectedServiceHours > 0
      ? Math.min(100, Math.round(recordedServiceHours * 10000 / expectedServiceHours) / 100)
      : null
    const overageGbOnRecordedData = Math.max(0, (totalBytes - includedBytes) / 1000 ** 3)

    const value = {
      ...data,
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
      measured_at: new Date().toISOString(),
      configured_service_ids: serviceIds,
      configured_services: serviceCount,
      included_gb: includedGb,
      included_bytes: includedBytes,
      expected_service_hours: expectedServiceHours,
      coverage_percent: coveragePercent,
      incomplete: expectedServiceHours === 0 || recordedServiceHours < expectedServiceHours ||
        (Number(data.missing_breakdown_hours) || 0) > 0 ||
        (serviceIds.length > 0 && (Number(data.tracked_services) || 0) < serviceIds.length),
      recorded_overage_gb: Number(overageGbOnRecordedData.toFixed(4)),
      illustrative_public_egress_cost_usd: Number((overageGbOnRecordedData * 0.15).toFixed(4)),
      illustrative_public_rate_usd_per_gb: 0.15,
      billing_note: 'Recorded metrics only. Estimates assume all excess traffic is public internet egress. Render Billing is authoritative; private link and unrecorded usage may change the invoice.',
    }
    renderMonthlyCache.value = value
    renderMonthlyCache.until = Date.now() + RENDER_MONTHLY_CACHE_MS
    return value
  })()

  renderMonthlyCache.pending = pending
  try {
    return await pending
  } finally {
    renderMonthlyCache.pending = null
  }
}

router.get('/render/bandwidth/monthly', viewSystemControl, async (req, res) => {
  try {
    const monthly = await loadRenderMonthlySummary()
    return res.status(200).json({ ok: true, monthly })
  } catch (error) {
    console.error('ADMIN_RENDER_MONTHLY_BANDWIDTH_ERROR:', error?.message || error)
    return res.status(500).json({
      ok: false,
      message: 'Unable to read stored Render bandwidth history. Verify the SQL function and backend permissions.',
    })
  }
})

function isInvalidInput(message) {
  return (
    message.includes('required') ||
    message.includes('after start') ||
    message.includes('cannot exceed') ||
    message.includes('must include past or current time') ||
    message.includes('Unsupported report type') ||
    message.includes('Unsupported incident status') ||
    message.includes('can only be applied') ||
    message.includes('must be FIX_APPLIED') ||
    message.includes('must be VERIFIED') ||
    message.includes('cannot be verified') ||
    message.includes('Only a RESOLVED incident')
  )
}

function incidentErrorStatus(message) {
  if (message.includes('Incident not found')) return 404
  return isInvalidInput(message) ? 400 : 500
}

function incidentError(res, error, fallback) {
  const message = String(
    error?.message || fallback
  )
  const status = incidentErrorStatus(message)

  if (status === 500) {
    console.error(
      'ADMIN_SYSTEM_CONTROL_INCIDENT_ACTION_ERROR:',
      error?.message || error
    )
  }

  return res.status(status).json({
    ok: false,
    message,
  })
}

router.get(
  '/snapshot',
  snapshotGuard,
  viewSystemControl,
  async (req, res) => {
    try {
      await refreshSystemUsageProviders({ force: false })
    } catch (error) {
      console.error(
        'ADMIN_SYSTEM_CONTROL_PROVIDER_REFRESH_ERROR:',
        error?.message || error
      )
    }

        return res.status(200).json({
      ok: true,
      usage: getSystemUsageCurrentSnapshot(),
      evidence: getRecentRequestEvidence(),
      guest_requests: getGuestRequestSnapshot(),
      page_requests: getPageRequestSnapshot(),
      anomaly: getSystemUsageAnomalySnapshot(),
      regression: getSystemUsageRegressionState(),
      providers: getSystemUsageProviderState(),
      runtime: getRuntimeMemoryInspector(),
    })
  }
)

router.post(
  '/providers/refresh',
  manageSystemControl,
  async (req, res) => {
    try {
      const providers =
        await refreshSystemUsageProviders({
          force: true,
        })

      return res.status(200).json({
        ok: true,
        providers,
      })
    } catch (error) {
      console.error(
        'ADMIN_SYSTEM_CONTROL_PROVIDER_FORCE_REFRESH_ERROR:',
        error?.message || error
      )

      return res.status(500).json({
        ok: false,
        message:
          'Failed to refresh provider usage.',
      })
    }
  }
)

router.get('/history', viewSystemControl, async (req, res) => {
  try {
    const history = await getSystemUsageHistory({
      from: req.query?.from,
      to: req.query?.to,
    })

    return res.status(200).json({
      ok: true,
      history,
    })
  } catch (error) {
    const message = String(
      error?.message || 'Failed to load usage history.'
    )

    return res.status(isInvalidInput(message) ? 400 : 500).json({
      ok: false,
      message,
    })
  }
})

router.get('/reports/download', viewSystemControl, async (req, res) => {
  try {
    const report = await generateSystemUsageReport({
      type: req.query?.type,
      from: req.query?.from,
      to: req.query?.to,
    })

    const filename = String(
      report.filename || 'system-control-report'
    ).replace(/[^a-zA-Z0-9._-]/g, '_')

    res.set('Content-Type', report.contentType)
    res.set(
      'Content-Disposition',
      `attachment; filename="${filename}"`
    )
    res.set('Content-Length', String(report.body.length))

    return res.status(200).send(report.body)
  } catch (error) {
    const message = String(
      error?.message ||
        'Failed to generate System Control report.'
    )

    if (!isInvalidInput(message)) {
      console.error(
        'ADMIN_SYSTEM_CONTROL_REPORT_ERROR:',
        error?.message || error
      )
    }

    return res.status(isInvalidInput(message) ? 400 : 500).json({
      ok: false,
      message,
    })
  }
})

router.get('/diagnostics/recent-errors', viewSystemControl, (req, res) => {
  const now = Date.now()
  const requested = Number(req.query?.minutes)
  const minutes = Number.isFinite(requested) && requested >= 5
    ? Math.min(120, Math.floor(requested))
    : 60
  const bucketMs = 15 * 60 * 1000
  const from = Math.floor((now - minutes * 60000) / bucketMs) * bucketMs
  const samples = getHistoricalErrorEvidence({ from, to: now })
  const groups = new Map()

  for (const entry of samples) {
    const key = JSON.stringify([
      entry.route, entry.http_status, entry.error_class,
      entry.provider, entry.target,
    ])
    const group = groups.get(key) || {
      route: entry.route,
      http_status: entry.http_status,
      error_class: entry.error_class,
      provider: entry.provider,
      target: entry.target,
      count: 0,
      external_error_count: 0,
      first_seen_at: entry.first_seen_at,
      last_seen_at: entry.last_seen_at,
      sample_request_id: entry.sample_request_id,
      sample_error: entry.sample_error,
    }
    group.count += Math.max(0, Number(entry.count) || 0)
    group.external_error_count += Math.max(0, Number(entry.external_error_count) || 0)
    if (Date.parse(entry.first_seen_at || '') < Date.parse(group.first_seen_at || '')) {
      group.first_seen_at = entry.first_seen_at
    }
    if (Date.parse(entry.last_seen_at || '') >= Date.parse(group.last_seen_at || '')) {
      group.last_seen_at = entry.last_seen_at
      group.sample_request_id = entry.sample_request_id
      group.sample_error = entry.sample_error
    }
    groups.set(key, group)
  }

  const ordered = [...groups.values()].sort(
    (a, b) => b.count - a.count ||
      Date.parse(b.last_seen_at || '') - Date.parse(a.last_seen_at || '')
  )
  res.status(200).json({
    ok: true,
    source: 'process_memory',
    history_complete: false,
    bucket_minutes: 15,
    window_start: new Date(from).toISOString(),
    window_end: new Date(now).toISOString(),
    total_observed: ordered.reduce((sum, item) => sum + item.count, 0),
    affected_routes: new Set(ordered.map((item) => item.route)).size,
    returned_groups: Math.min(50, ordered.length),
    has_more: ordered.length > 50,
    errors: ordered.slice(0, 50),
  })
})

router.get('/incidents', viewSystemControl, async (req, res) => {
  try {
    const incidents =
      await listSystemUsageIncidents({
        limit: req.query?.limit,
        from: req.query?.from,
        to: req.query?.to,
        status: req.query?.status,
      })

    return res.status(200).json({
      ok: true,
      incidents,
    })
  } catch (error) {
    const message = String(
      error?.message ||
        'Failed to load System Control incidents.'
    )

    if (!isInvalidInput(message)) {
      console.error(
        'ADMIN_SYSTEM_CONTROL_INCIDENTS_ERROR:',
        error?.message || error
      )
    }

    return res
      .status(
        isInvalidInput(message)
          ? 400
          : 500
      )
      .json({
        ok: false,
        message,
      })
  }
})

router.get('/incidents/:incidentId', viewSystemControl, async (req, res) => {
  try {
    const incident = await getSystemUsageIncident(
      req.params.incidentId
    )

    return res.status(200).json({
      ok: true,
      incident,
    })
  } catch (error) {
    return incidentError(
      res,
      error,
      'Failed to load incident.'
    )
  }
})

router.post(
  '/incidents/:incidentId/fix',
  manageSystemControl,
  async (req, res) => {
    try {
      const incident = await applySystemUsageIncidentFix({
        incidentId: req.params.incidentId,
        fixSummary:
          req.body?.fix_summary ??
          req.body?.fixSummary,
        fixCommit:
          req.body?.fix_commit ??
          req.body?.fixCommit,
        fixVersion:
          req.body?.fix_version ??
          req.body?.fixVersion,
      })

      return res.status(200).json({
        ok: true,
        incident,
      })
    } catch (error) {
      return incidentError(
        res,
        error,
        'Failed to mark fix as applied.'
      )
    }
  }
)

router.post(
  '/incidents/:incidentId/verify',
  manageSystemControl,
  async (req, res) => {
    try {
      const incident = await verifySystemUsageIncident({
        incidentId: req.params.incidentId,
      })

      return res.status(200).json({
        ok: true,
        incident,
      })
    } catch (error) {
      return incidentError(
        res,
        error,
        'Failed to verify incident.'
      )
    }
  }
)

router.post(
  '/incidents/:incidentId/resolve',
  manageSystemControl,
  async (req, res) => {
    try {
      const incident = await resolveSystemUsageIncident({
        incidentId: req.params.incidentId,
        summary:
          req.body?.summary ??
          req.body?.resolution_summary ??
          req.body?.resolutionSummary,
      })

      return res.status(200).json({
        ok: true,
        incident,
      })
    } catch (error) {
      return incidentError(
        res,
        error,
        'Failed to resolve incident.'
      )
    }
  }
)

router.post(
  '/incidents/:incidentId/archive',
  manageSystemControl,
  async (req, res) => {
    try {
      const incident = await archiveSystemUsageIncident({
        incidentId: req.params.incidentId,
      })

      return res.status(200).json({
        ok: true,
        incident,
      })
    } catch (error) {
      return incidentError(
        res,
        error,
        'Failed to archive incident.'
      )
    }
  }
)

export default router
