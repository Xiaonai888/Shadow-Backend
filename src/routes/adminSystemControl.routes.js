import express from 'express'
import { requireAdminPermission } from '../middleware/adminPermission.middleware.js'
import { getSystemUsageCurrentSnapshot } from '../services/systemUsageMonitor.service.js'
import { getSystemUsageAnomalySnapshot } from '../services/systemUsageAnomaly.service.js'
import { listSystemUsageIncidents } from '../services/systemUsageIncident.service.js'
import { getSystemUsageHistory } from '../services/systemUsagePersistence.service.js'

const router = express.Router()
const viewSystemControl = requireAdminPermission('system_control.view')

router.use(viewSystemControl)
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store')
  next()
})

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
    const message = String(error?.message || 'Failed to load usage history.')
    const invalid =
      message.includes('required') ||
      message.includes('after start') ||
      message.includes('cannot exceed')

    return res.status(invalid ? 400 : 500).json({
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
