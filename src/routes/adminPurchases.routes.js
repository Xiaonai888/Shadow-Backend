import { streamAdminPaymentEvents } from '../services/adminPaymentSse.service.js'
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
  retryAdminTelegramReport,
} from '../controllers/adminManualPayments.controller.js'

const router = express.Router()

router.get('/', requireAdmin, getAdminPayments)
router.get('/manual', requireAdmin, getAdminManualPayments)
router.get('/manual/stream', requireAdmin, streamAdminPaymentEvents)
router.post('/manual/:paymentId/confirm', requireAdmin, confirmAdminManualPayment)
router.post('/manual/:paymentId/reject', requireAdmin, rejectAdminManualPayment)
router.post('/manual/:paymentId/retry-telegram-report', requireAdmin, retryAdminTelegramReport)
router.get('/:paymentId', requireAdmin, getAdminPayment)

export default router
