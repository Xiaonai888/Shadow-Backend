import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  getAdminReport,
  getAdminReports,
  getAdminReportStats,
  updateAdminReport,
} from '../controllers/adminReports.controller.js'

const router = express.Router()

router.get('/stats', requireAdmin, getAdminReportStats)
router.get('/', requireAdmin, getAdminReports)
router.get('/:reportId', requireAdmin, getAdminReport)
router.patch('/:reportId', requireAdmin, updateAdminReport)

export default router
