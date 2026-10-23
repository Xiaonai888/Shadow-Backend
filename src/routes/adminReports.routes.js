import express from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  getAdminReport,
  getAdminReports,
  getAdminReportStats,
  updateAdminReport,
} from '../controllers/adminReports.controller.js'

const router = express.Router()

const adminReportIdentity = (req) => String(
  req.admin?.admin_id ||
  req.admin?.id ||
  req.admin?.email ||
  ipKeyGenerator(req.ip)
)

const adminReportReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: adminReportIdentity,
  message: {
    ok: false,
    code: 'ADMIN_REPORT_READ_RATE_LIMIT',
    message: 'Too many report requests. Please try again shortly.',
  },
})

const adminReportWriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: adminReportIdentity,
  message: {
    ok: false,
    code: 'ADMIN_REPORT_WRITE_RATE_LIMIT',
    message: 'Too many report changes. Please try again shortly.',
  },
})

router.get('/stats', requireAdmin, adminReportReadLimit, getAdminReportStats)
router.get('/', requireAdmin, adminReportReadLimit, getAdminReports)
router.get('/:reportId', requireAdmin, adminReportReadLimit, getAdminReport)
router.patch('/:reportId', requireAdmin, adminReportWriteLimit, updateAdminReport)

export default router
