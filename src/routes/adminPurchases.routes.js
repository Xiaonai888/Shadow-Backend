import { streamAdminPaymentEvents } from '../services/adminPaymentSse.service.js'
import {
  getAdminPaymentRecovery,
  getAdminPaymentRecoveryRecipient,
  getAdminPaymentRecoveryHistory,
  confirmAdminPaymentRecovery,
  confirmAdminManualTopUp,
} from '../controllers/adminPaymentRecovery.controller.js'
import {
  getAdminPaymentHistoryMetadata,
  getAdminPaymentActionDetails,
  getAdminPaymentActionEdits,
  updateAdminPaymentActionMetadata,
} from '../controllers/adminPaymentHistoryEdits.controller.js'
import {
  getAdminBinanceReceivedUsdt,
  getAdminBinanceAlertHistory,
  getAdminBinanceReceiptDetails,
} from '../controllers/adminBinanceReceipts.controller.js'
import {
  getAdminBinanceCreditAvailability,
  getAdminBinanceCreditHistory,
  getAdminBinanceCreditActionDetails,
  getAdminBinanceCreditActionEdits,
  confirmAdminBinanceReceiptCredit,
  confirmAdminBinanceManualTopUp,
  updateAdminBinanceCreditActionMetadata,
} from '../controllers/adminBinanceCredits.controller.js'
import { createSpamGuard } from '../middleware/spamGuard.middleware.js'
import express from 'express'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
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
const binanceReadGuard = createSpamGuard({ scope: 'admin_binance_credit_read', threshold: 30, windowSeconds: 60 })
const binanceWriteGuard = createSpamGuard({ scope: 'admin_binance_credit_write', threshold: 5, windowSeconds: 60 })

const adminPaymentPreAuthLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 1200,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, code: 'ADMIN_PAYMENT_PRE_AUTH_RATE_LIMIT', message: 'Too many payment requests. Please retry shortly.' },
})
const adminPaymentReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.admin?.admin_id || req.admin?.id || ipKeyGenerator(req.ip)),
  message: { ok: false, code: 'ADMIN_PAYMENT_READ_RATE_LIMIT', message: 'Too many payment requests. Please retry shortly.' },
})
const adminPaymentWriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.admin?.admin_id || req.admin?.id || ipKeyGenerator(req.ip)),
  message: { ok: false, code: 'ADMIN_PAYMENT_WRITE_RATE_LIMIT', message: 'Too many payment actions. Please retry shortly.' },
})

router.use(adminPaymentPreAuthLimit)

router.get('/', requireAdmin, adminPaymentReadLimit, getAdminPayments)
router.get('/manual', requireAdmin, adminPaymentReadLimit, getAdminManualPayments)
router.get('/recovery', requireAdmin, adminPaymentReadLimit, recoveryReadGuard, getAdminPaymentRecovery)
router.get('/recovery/recipients', requireAdmin, adminPaymentReadLimit, recoveryReadGuard, getAdminPaymentRecoveryRecipient)
router.get('/recovery/history', requireAdmin, adminPaymentReadLimit, recoveryReadGuard, getAdminPaymentRecoveryHistory)
router.get('/recovery/history/metadata', requireAdmin, adminPaymentReadLimit, recoveryReadGuard, getAdminPaymentHistoryMetadata)
router.get('/recovery/history/:actionId/edits', requireAdmin, adminPaymentReadLimit, recoveryReadGuard, getAdminPaymentActionEdits)
router.get('/recovery/history/:actionId', requireAdmin, adminPaymentReadLimit, recoveryReadGuard, getAdminPaymentActionDetails)
router.patch('/recovery/history/:actionId', requireAdmin, adminPaymentWriteLimit, recoveryWriteGuard, updateAdminPaymentActionMetadata)
router.post('/recovery/topup', requireAdmin, adminPaymentWriteLimit, recoveryWriteGuard, confirmAdminManualTopUp)
router.post('/recovery/:paymentId/confirm', requireAdmin, adminPaymentWriteLimit, recoveryWriteGuard, confirmAdminPaymentRecovery)
router.get('/binance/received-usdt', requireAdmin, adminPaymentReadLimit, binanceReadGuard, getAdminBinanceReceivedUsdt)
router.get('/binance/alert-history', requireAdmin, adminPaymentReadLimit, binanceReadGuard, getAdminBinanceAlertHistory)
router.get('/binance/availability', requireAdmin, adminPaymentReadLimit, binanceReadGuard, getAdminBinanceCreditAvailability)
router.get('/binance/recipients', requireAdmin, adminPaymentReadLimit, binanceReadGuard, getAdminPaymentRecoveryRecipient)
router.get('/binance/receipts/:transactionId', requireAdmin, adminPaymentReadLimit, binanceReadGuard, getAdminBinanceReceiptDetails)
router.get('/binance/history', requireAdmin, adminPaymentReadLimit, binanceReadGuard, getAdminBinanceCreditHistory)
router.get('/binance/history/:actionId/edits', requireAdmin, adminPaymentReadLimit, binanceReadGuard, getAdminBinanceCreditActionEdits)
router.get('/binance/history/:actionId', requireAdmin, adminPaymentReadLimit, binanceReadGuard, getAdminBinanceCreditActionDetails)
router.patch('/binance/history/:actionId', requireAdmin, adminPaymentWriteLimit, binanceWriteGuard, updateAdminBinanceCreditActionMetadata)
router.post('/binance/recovery/confirm', requireAdmin, adminPaymentWriteLimit, binanceWriteGuard, confirmAdminBinanceReceiptCredit)
router.post('/binance/topup', requireAdmin, adminPaymentWriteLimit, binanceWriteGuard, confirmAdminBinanceManualTopUp)
router.get('/manual/stream', requireAdmin, adminPaymentReadLimit, streamAdminPaymentEvents)
router.post('/manual/:paymentId/confirm', requireAdmin, adminPaymentWriteLimit, (_req, res) => {
  return res.status(410).json({
    ok: false,
    message: 'Use Payment Recovery & Top-Up with Admin Passkey.'
  })
})
router.post('/manual/:paymentId/reject', requireAdmin, adminPaymentWriteLimit, rejectAdminManualPayment)
router.post('/manual/:paymentId/retry-telegram-report', requireAdmin, adminPaymentWriteLimit, retryAdminTelegramReport)
router.get('/:paymentId', requireAdmin, adminPaymentReadLimit, getAdminPayment)

export default router
