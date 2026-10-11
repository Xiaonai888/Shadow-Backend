import { streamAdminPaymentEvents } from '../services/adminPaymentSse.service.js'
import {
  getAdminPaymentRecovery,
  getAdminPaymentRecoveryRecipient,
  getAdminPaymentRecoveryHistory,
  confirmAdminPaymentRecovery,
  confirmAdminManualTopUp,
} from '../controllers/adminPaymentRecovery.controller.js'
import { createSpamGuard } from '../middleware/spamGuard.middleware.js'
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
const recoveryReadGuard = createSpamGuard({ scope: 'admin_payment_recovery_read', threshold: 30, windowSeconds: 60 })
const recoveryWriteGuard = createSpamGuard({ scope: 'admin_payment_recovery_write', threshold: 10, windowSeconds: 60 })

router.get('/', requireAdmin, getAdminPayments)
router.get('/manual', requireAdmin, getAdminManualPayments)
router.get('/recovery', requireAdmin, recoveryReadGuard, getAdminPaymentRecovery)
router.get('/recovery/recipients', requireAdmin, recoveryReadGuard, getAdminPaymentRecoveryRecipient)
router.get('/recovery/history', requireAdmin, recoveryReadGuard, getAdminPaymentRecoveryHistory)
router.post('/recovery/topup', requireAdmin, recoveryWriteGuard, confirmAdminManualTopUp)
router.post('/recovery/:paymentId/confirm', requireAdmin, recoveryWriteGuard, confirmAdminPaymentRecovery)
router.get('/manual/stream', requireAdmin, streamAdminPaymentEvents)
router.post('/manual/:paymentId/confirm', requireAdmin, confirmAdminManualPayment)
router.post('/manual/:paymentId/reject', requireAdmin, rejectAdminManualPayment)
router.post('/manual/:paymentId/retry-telegram-report', requireAdmin, retryAdminTelegramReport)
router.get('/:paymentId', requireAdmin, getAdminPayment)

export default router
