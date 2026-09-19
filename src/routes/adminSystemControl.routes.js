import express from 'express'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import { getSystemUsageCurrentSnapshot } from '../services/systemUsageMonitor.service.js'
import { getSystemUsageAnomalySnapshot } from '../services/systemUsageAnomaly.service.js'
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
  max: 20,
  message: 'Too many System Control snapshot requests. Please wait before refreshing again.',
})

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store')
  next()
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
      anomaly: getSystemUsageAnomalySnapshot(),
      providers: getSystemUsageProviderState(),
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
