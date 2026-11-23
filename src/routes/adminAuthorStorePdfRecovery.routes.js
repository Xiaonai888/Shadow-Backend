import express from 'express'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  getAdminAuthorStorePdfRecoveryDetail,
  listAdminAuthorStorePdfRecoveryHistory,
  listAdminAuthorStorePdfRecovery,
  manuallyConfirmAdminAuthorStorePdfPayment,
  recoverAdminAuthorStorePdfOrder,
} from '../controllers/adminAuthorStorePdfRecovery.controller.js'

const router = express.Router()
const readIpLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
})
const writeIpLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
})
const readLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.admin?.admin_id || req.admin?.id || ipKeyGenerator(req.ip)),
})
const writeLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.admin?.admin_id || req.admin?.id || ipKeyGenerator(req.ip)),
})

router.get('/', readIpLimit, requireAdmin, readLimit, listAdminAuthorStorePdfRecovery)
router.get('/history', readIpLimit, requireAdmin, readLimit, listAdminAuthorStorePdfRecoveryHistory)
router.get('/:orderId', readIpLimit, requireAdmin, readLimit, getAdminAuthorStorePdfRecoveryDetail)
router.post('/:orderId/recover', writeIpLimit, requireAdmin, writeLimit, recoverAdminAuthorStorePdfOrder)
router.post('/:orderId/manual-confirm', writeIpLimit, requireAdmin, writeLimit, manuallyConfirmAdminAuthorStorePdfPayment)

export default router
