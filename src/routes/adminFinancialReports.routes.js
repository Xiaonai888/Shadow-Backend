import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import {
  connectAdminFinancialReportsSheet,
  getAdminFinancialReportsStatus,
  syncAdminFinancialReportsSheet,
} from '../controllers/adminFinancialReports.controller.js'
import { getAdminFinancialReportsHistoryRange } from '../controllers/adminFinancialReportsHistory.controller.js'

const router = express.Router()
const preAuthIpLimit = createRateLimit({
  key: 'admin-financial-reports-preauth-ip',
  max: 60,
  windowMs: 60 * 1000,
  message: 'Too many Financial Reports requests. Try again shortly.',
})
const requestLimit = createRateLimit({
  key: 'admin-financial-reports-sync',
  max: 6,
  windowMs: 60 * 1000,
  message: 'Too many Financial Reports requests. Try again shortly.',
  identity: (req) => req.admin?.admin_id || req.admin?.id || req.admin?.email,
})

const preventCaching = (req, res, next) => {
  res.set('Cache-Control', 'private, no-store')
  next()
}

router.get('/status', preAuthIpLimit, requireAdmin, preventCaching, getAdminFinancialReportsStatus)
router.get('/history-range', preAuthIpLimit, requireAdmin, preventCaching, getAdminFinancialReportsHistoryRange)
router.post('/connect', preAuthIpLimit, requireAdmin, preventCaching, requestLimit, connectAdminFinancialReportsSheet)
router.post('/sync', preAuthIpLimit, requireAdmin, preventCaching, requestLimit, syncAdminFinancialReportsSheet)

export default router
