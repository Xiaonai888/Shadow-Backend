import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  getAdminPayment,
  getAdminPayments,
} from '../controllers/adminPayments.controller.js'

const router = express.Router()

router.get('/', requireAdmin, getAdminPayments)
router.get('/:paymentId', requireAdmin, getAdminPayment)

export default router
