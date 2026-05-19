import express from 'express'
import multer from 'multer'
import { requireUser } from '../middleware/user.middleware.js'
import {
  createAbaPayment,
  getAbaPaymentStatus,
  getMyPurchaseRequests,
  getMyWallet,
  getPurchasePackages,
  handleAbaCallback,
} from '../controllers/purchase.controller.js'
import {
  createManualPayment,
  getManualPaymentStatus,
  submitManualPaymentProof,
} from '../controllers/manualPayments.controller.js'

const router = express.Router()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
})

router.get('/packages', getPurchasePackages)
router.get('/wallet', requireUser, getMyWallet)
router.get('/requests', requireUser, getMyPurchaseRequests)

router.post('/manual/create', requireUser, createManualPayment)
router.post('/manual/proof/:orderId', requireUser, upload.single('proof_image'), submitManualPaymentProof)
router.get('/manual/status/:orderId', requireUser, getManualPaymentStatus)

router.post('/aba/create', requireUser, createAbaPayment)
router.get('/aba/status/:orderId', requireUser, getAbaPaymentStatus)
router.post('/aba/callback', handleAbaCallback)

export default router
