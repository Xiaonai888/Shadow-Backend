import express from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import {
  getMyAuthorPreOrderPaidOrders,
  downloadMyAuthorPreOrderPaidOrdersExcel,
} from '../controllers/authorPreOrderReports.controller.js'

const router = express.Router()

const preAuthIpLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, code: 'PRE_ORDER_REPORT_IP_RATE_LIMITED', message: 'Too many report requests from this IP' },
})

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: req => String(req.user?.user_id || ipKeyGenerator(req.ip)),
  message: { ok: false, code: 'PRE_ORDER_REPORT_RATE_LIMITED', message: 'Too many report requests' },
})

const exportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 6,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: req => String(req.user?.user_id || ipKeyGenerator(req.ip)),
  message: { ok: false, code: 'PRE_ORDER_REPORT_EXPORT_LIMITED', message: 'Too many Excel exports' },
})

router.get('/me/pre-order-reports/paid-orders', preAuthIpLimiter, requireUser, readLimiter, getMyAuthorPreOrderPaidOrders)
router.get('/me/pre-order-reports/excel', preAuthIpLimiter, requireUser, readLimiter, exportLimiter, downloadMyAuthorPreOrderPaidOrdersExcel)

export default router
