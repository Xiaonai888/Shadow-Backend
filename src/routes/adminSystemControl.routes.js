import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { getSystemUsageCurrentSnapshot } from '../services/systemUsageMonitor.service.js'
import { getSystemUsageAnomalySnapshot } from '../services/systemUsageAnomaly.service.js'
import { listSystemUsageIncidents } from '../services/systemUsageIncident.service.js'

const router = express.Router()

router.use(requireAdmin)

router.get('/snapshot', (req, res) => {
  return res.status(200).json({
    ok: true,
    usage: getSystemUsageCurrentSnapshot(),
    anomaly: getSystemUsageAnomalySnapshot(),
  })
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
