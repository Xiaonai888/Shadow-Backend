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

router.use(requireAdmin)
router.get('/', readLimit, listAdminAuthorStorePdfRecovery)
router.get('/history', readLimit, listAdminAuthorStorePdfRecoveryHistory)
router.get('/:orderId', readLimit, getAdminAuthorStorePdfRecoveryDetail)
router.post('/:orderId/recover', writeLimit, recoverAdminAuthorStorePdfOrder)
router.post('/:orderId/manual-confirm', writeLimit, manuallyConfirmAdminAuthorStorePdfPayment)

export default router
