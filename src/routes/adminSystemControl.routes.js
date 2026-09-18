import express from 'express'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { getSystemUsageCurrentSnapshot } from '../services/systemUsageMonitor.service.js'
import { getSystemUsageAnomalySnapshot } from '../services/systemUsageAnomaly.service.js'
import { listSystemUsageIncidents } from '../services/systemUsageIncident.service.js'
import { getSystemUsageHistory } from '../services/systemUsagePersistence.service.js'
import { generateSystemUsageReport } from '../services/systemUsageReport.service.js'

const router = express.Router()
const viewSystemControl = requireAdminPermission('system_control.view')

router.use(viewSystemControl)
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
    message.includes('Unsupported report type')
  )
}

router.get('/snapshot', (req, res) => {
  return res.status(200).json({
    ok: true,
    usage: getSystemUsageCurrentSnapshot(),
    anomaly: getSystemUsageAnomalySnapshot(),
  })
})

router.get('/history', async (req, res) => {
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

router.get('/reports/download', async (req, res) => {
  try {
    const report = await generateSystemUsageReport({
      type: req.query?.type,
      from: req.query?.from,
      to: req.query?.to,
    })

    const filename = String(report.filename || 'system-control-report')
      .replace(/[^a-zA-Z0-9._-]/g, '_')

    res.set('Content-Type', report.contentType)
    res.set(
      'Content-Disposition',
      `attachment; filename="${filename}"`
    )
    res.set('Content-Length', String(report.body.length))

    return res.status(200).send(report.body)
  } catch (error) {
    const message = String(
      error?.message || 'Failed to generate System Control report.'
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

router.get('/incidents', async (req, res) => {
  try {
    const incidents = await listSystemUsageIncidents(req.query?.limit)

    return res.status(200).json({
      ok: true,
      incidents,
    })
  } catch (error) {
    console.error(
      'ADMIN_SYSTEM_CONTROL_INCIDENTS_ERROR:',
      error?.message || error
    )

    return res.status(500).json({
      ok: false,
      message: 'Failed to load System Control incidents.',
    })
  }
})

export default router
