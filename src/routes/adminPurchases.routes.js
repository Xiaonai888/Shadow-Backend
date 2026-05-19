import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  getAdminPayment,
  getAdminPayments,
} from '../controllers/adminPayments.controller.js'
import {
  confirmAdminManualPayment,
  getAdminManualPayments,
  rejectAdminManualPayment,
} from '../controllers/adminManualPayments.controller.js'

const router = express.Router()

router.get('/', requireAdmin, getAdminPayments)
router.get('/manual', requireAdmin, getAdminManualPayments)
router.post('/manual/:paymentId/confirm', requireAdmin, confirmAdminManualPayment)
router.post('/manual/:paymentId/reject', requireAdmin, rejectAdminManualPayment)
router.get('/:paymentId', requireAdmin, getAdminPayment)

export default router
