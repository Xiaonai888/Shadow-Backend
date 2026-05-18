import express from 'express'
import { requireUser } from '../middleware/user.middleware.js'
import {
  createPurchaseRequest,
  getMyPurchaseRequests,
  getMyWallet,
  getPurchasePackages,
} from '../controllers/purchase.controller.js'

const router = express.Router()

router.get('/packages', getPurchasePackages)
router.get('/wallet', requireUser, getMyWallet)
router.get('/requests', requireUser, getMyPurchaseRequests)
router.post('/requests', requireUser, createPurchaseRequest)

export default router
