import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import {
  connectAdminFinancialReportsSheet,
  getAdminFinancialReportsStatus,
  syncAdminFinancialReportsSheet,
} from '../controllers/adminFinancialReports.controller.js'

const router = express.Router()
const requestLimit = createRateLimit({
  key: 'admin-financial-reports-sync',
  max: 6,
  windowMs: 60 * 1000,
  message: 'Too many Financial Reports requests. Try again shortly.',
  identity: (req) => req.admin?.admin_id || req.admin?.id || req.admin?.email,
})

router.use(requireAdmin)
router.use((req, res, next) => {
  res.set('Cache-Control', 'private, no-store')
  next()
})
router.get('/status', getAdminFinancialReportsStatus)
router.post('/connect', requestLimit, connectAdminFinancialReportsSheet)
router.post('/sync', requestLimit, syncAdminFinancialReportsSheet)

export default router
