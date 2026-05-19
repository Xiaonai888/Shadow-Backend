import express from 'express'
import { requireUser } from '../middleware/user.middleware.js'
import {
  createAbaPayment,
  getAbaPaymentStatus,
  getMyPurchaseRequests,
  getMyWallet,
  getPurchasePackages,
  handleAbaCallback,
} from '../controllers/purchase.controller.js'

const router = express.Router()

router.get('/packages', getPurchasePackages)
router.get('/wallet', requireUser, getMyWallet)
router.get('/requests', requireUser, getMyPurchaseRequests)
router.post('/aba/create', requireUser, createAbaPayment)
router.get('/aba/status/:orderId', requireUser, getAbaPaymentStatus)
router.post('/aba/callback', handleAbaCallback)

export default router
