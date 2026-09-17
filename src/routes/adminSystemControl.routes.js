import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { getSystemUsageCurrentSnapshot } from '../services/systemUsageMonitor.service.js'

const router = express.Router()

router.use(requireAdmin)

router.get('/snapshot', (req, res) => {
  return res.status(200).json({
    ok: true,
    usage: getSystemUsageCurrentSnapshot(),
  })
})

export default router
