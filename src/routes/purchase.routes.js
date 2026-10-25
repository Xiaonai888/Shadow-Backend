import express from 'express'
import multer from 'multer'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import { requirePaymentCountry } from '../middleware/paymentCountryGate.middleware.js'
import binanceReceiverRoutes from './binanceReceiver.routes.js'
import binanceCheckoutRoutes from './binanceCheckout.routes.js'
import binanceCheckoutClaimsRoutes from './binanceCheckoutClaims.routes.js'
import {
  createAbaPayment,
  getAbaPaymentStatus,
  getMyPurchaseRequests,
  getMyWallet,
  getPurchasePackages,
  handleAbaCallback,
} from '../controllers/purchase.controller.js'
import {
  getFirstTopupBonus,
  openFirstTopupBonus,
} from '../controllers/firstTopupBonus.controller.js'
import {
  cancelManualPayment,
  createManualPayment,
  getManualPaymentStatus,
  submitManualPaymentProof,
} from '../controllers/manualPayments.controller.js'
import {
  cancelPremiumPayment,
  createPremiumPayment,
  getPremiumPaymentStatus,
  getPremiumPlans,
  getPremiumStatus,
} from '../controllers/premiumPayments.controller.js'
import { openPaymentEventStream } from '../services/paymentEvents.service.js'
import {
  getNextDiamondCreditNotice,
  markDiamondCreditNoticeSeen,
} from '../controllers/diamondCreditNotices.controller.js'

const router = express.Router()
const purchasePreAuthLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 1200,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
})
const purchaseReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id || req.user?.session_id || 'unauthenticated'),
})
const purchaseWriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id || req.user?.session_id || 'unauthenticated'),
})
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
})

router.use('/binance', purchasePreAuthLimit, binanceReceiverRoutes)
router.use('/binance', purchasePreAuthLimit, binanceCheckoutRoutes)
router.use('/binance', purchasePreAuthLimit, binanceCheckoutClaimsRoutes)

router.get('/packages', purchasePreAuthLimit, getPurchasePackages)
router.get('/wallet', purchasePreAuthLimit, requireUser, purchaseReadLimit, getMyWallet)
router.get('/requests', purchasePreAuthLimit, requireUser, purchaseReadLimit, getMyPurchaseRequests)
router.get('/first-topup-bonus', purchasePreAuthLimit, requireUser, purchaseReadLimit, getFirstTopupBonus)
router.post('/first-topup-bonus/open', purchasePreAuthLimit, requireUser, purchaseWriteLimit, openFirstTopupBonus)

router.post(
  '/manual/create',
  purchasePreAuthLimit,
  requireUser,
  purchaseWriteLimit,
  requirePaymentCountry('payway'),
  createManualPayment
)
router.post('/manual/cancel/:orderId', purchasePreAuthLimit, requireUser, purchaseWriteLimit, cancelManualPayment)
router.post('/manual/proof/:orderId', purchasePreAuthLimit, requireUser, purchaseWriteLimit, upload.single('proof_image'), submitManualPaymentProof)
router.get('/manual/status/:orderId', purchasePreAuthLimit, requireUser, purchaseReadLimit, getManualPaymentStatus)
router.get('/manual/events/:orderId', purchasePreAuthLimit, requireUser, purchaseReadLimit, openPaymentEventStream)
router.get('/credit-notices/next', purchasePreAuthLimit, requireUser, purchaseReadLimit, getNextDiamondCreditNotice)
router.patch('/credit-notices/:noticeId/seen', purchasePreAuthLimit, requireUser, purchaseWriteLimit, markDiamondCreditNoticeSeen)

router.get('/premium/plans', purchasePreAuthLimit, getPremiumPlans)
router.get('/premium/status', purchasePreAuthLimit, requireUser, purchaseReadLimit, getPremiumStatus)
router.post('/premium/create', purchasePreAuthLimit, requireUser, purchaseWriteLimit, createPremiumPayment)
router.get('/premium/status/:orderId', purchasePreAuthLimit, requireUser, purchaseReadLimit, getPremiumPaymentStatus)
router.post('/premium/cancel/:orderId', purchasePreAuthLimit, requireUser, purchaseWriteLimit, cancelPremiumPayment)

router.post(
  '/aba/create',
  purchasePreAuthLimit,
  requireUser,
  purchaseWriteLimit,
  requirePaymentCountry('payway'),
  createAbaPayment
)
router.get('/aba/status/:orderId', purchasePreAuthLimit, requireUser, purchaseReadLimit, getAbaPaymentStatus)
router.post('/aba/callback', handleAbaCallback)

export default router
