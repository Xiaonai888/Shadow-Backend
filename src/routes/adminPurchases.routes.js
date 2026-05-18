import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  approveAdminPurchaseRequest,
  getAdminPurchaseRequest,
  getAdminPurchaseRequests,
  rejectAdminPurchaseRequest,
} from '../controllers/purchase.controller.js'

const router = express.Router()

router.get('/', requireAdmin, getAdminPurchaseRequests)
router.get('/:requestId', requireAdmin, getAdminPurchaseRequest)
router.patch('/:requestId/approve', requireAdmin, approveAdminPurchaseRequest)
router.patch('/:requestId/reject', requireAdmin, rejectAdminPurchaseRequest)

export default router
