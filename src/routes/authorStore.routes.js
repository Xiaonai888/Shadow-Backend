import { getReaderStoreHome } from '../controllers/readerStore.controller.js'
import { getMyAuthorStoreEarnings } from '../controllers/authorStoreEarnings.controller.js'
import { getMyAuthorStoreBookPending, confirmMyAuthorStoreBookReceived } from '../controllers/authorStoreBookPending.controller.js'
import { submitMyAuthorStoreBookEvidence, getMyAuthorStoreBuyerBookHoldStatuses, getAdminAuthorStoreBookHolds } from '../controllers/authorStoreBookWorkflow.controller.js'
import { approveAdminAuthorStoreBookHold } from '../controllers/adminAuthorStoreBookApproval.controller.js'
import express from 'express'
import multer from 'multer'
import os from 'node:os'
import { unlink } from 'node:fs/promises'
import { getMyAuthorStoreOfflinePdfGrant, getMyAuthorStorePurchasedPdf } from '../controllers/authorStoreOfflinePdf.controller.js'
import {
  createAuthorStoreOrder,
  createAuthorStoreOrderPayment,
  createMyAuthorStoreCategory,
  createMyAuthorStoreProduct,
  createMyAuthorStoreWithdrawal,
  deleteMyAuthorStoreCategory,
  deleteMyAuthorStoreProduct,
  getAdminAuthorStoreOrders,
  getAuthorStoreOrderStatus,
  getMyAuthorStoreBuyerOrders,
  getMyAuthorStoreCategories,
  getMyAuthorStoreDeliverySettings,
  getMyAuthorStoreIncome,
  getMyAuthorStoreOrders,
  getMyAuthorStoreProducts,
  getMyAuthorStorePromotion,
  getMyAuthorStoreReaderDownloads,
  getMyAuthorStoreTelegramSettings,
  getPublicAuthorStoreProducts,
  handleAuthorStoreAbaCallback,
  handleAuthorStoreTelegramWebhook,
  reorderMyAuthorStoreCategories,
  resendAdminAuthorStoreOrderTelegram,
  unlinkMyAuthorStoreTelegramGroup,
  updateAdminAuthorStoreOrderStatus,
  updateMyAuthorStoreCategory,
  updateMyAuthorStoreDeliverySettings,
  updateMyAuthorStoreProduct,
  getAdminAuthorStoreWithdrawals,
  createMyAuthorStoreTelegramConnectLink,
  updateAdminAuthorStoreWithdrawalStatus,
  markMyAuthorStoreOrderPreparing,
  getAdminAuthorStoreStores,
  getAdminAuthorStoreStoreDetails,
} from '../controllers/authorStore.controller.js'
import {
  recordAdminAuthorStoreTransfer,
  uploadAdminAuthorStoreReceipt,
  getAdminAuthorStoreReceipt,
} from '../controllers/adminAuthorStoreWithdrawalWorkflow.controller.js'
import {
  attachMyAuthorStorePrivatePdf,
  uploadMyAuthorStorePrivatePdf,
} from '../controllers/authorStorePdf.controller.js'
import {
  connectMyAuthorStoreSalesReports,
  disconnectMyAuthorStoreSalesReports,
  getMyAuthorStoreSalesReports,
  syncMyAuthorStoreSalesReports,
} from '../controllers/authorStoreSalesReports.controller.js'
import { requireUser } from '../middleware/user.middleware.js'
import { requireAuthorStorePhysicalBookCountry } from '../middleware/authorStorePhysicalBookGuard.middleware.js'
import { createRateLimit as createIpLimiter } from '../middleware/rateLimit.middleware.js'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { getAdminAuthorStoreWithdrawalNotifications } from '../controllers/adminAuthorStoreWithdrawalNotifications.controller.js'
import { validateAuthorStorePdf, deleteMyAuthorStoreTemporaryPdf } from '../controllers/authorStorePdfGuard.controller.js'
import authorStoreBookProofRoutes from './authorStoreBookProof.routes.js'
import authorStoreBookShipmentRoutes from './authorStoreBookShipment.routes.js'

const router = express.Router()

const privatePdfUpload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 1,
  },
  fileFilter: (req, file, callback) => {
    const originalName = String(file?.originalname || '').toLowerCase()

    if (!originalName.endsWith('.pdf')) {
      const error = new Error('Only PDF files are allowed')
      error.statusCode = 400
      callback(error)
      return
    }

    callback(null, true)
  },
})

const handlePrivatePdfUpload = (req, res, next) => {
  privatePdfUpload.single('pdf')(req, res, (error) => {
    if (!error) return next()
    const tooLarge = error.code === 'LIMIT_FILE_SIZE'
    const invalid = error instanceof multer.MulterError || error.statusCode === 400
    console.error('AUTHOR STORE PDF UPLOAD REJECTED:', error)
    return res.status(tooLarge ? 413 : invalid ? 400 : 500).json({
      ok: false,
      code: error.code || 'PDF_UPLOAD_REJECTED',
      message: tooLarge ? 'PDF exceeds 50 MB' : invalid ? error.message : 'PDF could not be processed by server',
    })
  })
}

function cleanupPrivatePdfTemp(req, res, next) {
  const filePath = String(req.file?.path || '').trim()

  if (!filePath) {
    next()
    return
  }

  let cleaned = false

  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    unlink(filePath).catch(() => {})
  }

  res.once('finish', cleanup)
  res.once('close', cleanup)
  next()
}

router.get('/me/products', requireUser, getMyAuthorStoreProducts)
router.get('/me/promotion', requireUser, getMyAuthorStorePromotion)
router.get('/me/categories', requireUser, getMyAuthorStoreCategories)
router.get('/me/delivery-settings', requireUser, getMyAuthorStoreDeliverySettings)
router.post('/telegram/webhook', handleAuthorStoreTelegramWebhook)
router.get('/me/telegram-settings', requireUser, getMyAuthorStoreTelegramSettings)
router.post('/me/telegram-settings/connect-link', requireUser, createMyAuthorStoreTelegramConnectLink)
router.post('/me/telegram-settings/unlink', requireUser, unlinkMyAuthorStoreTelegramGroup)
router.get('/me/sales-reports', requireUser, getMyAuthorStoreSalesReports)
router.post('/me/sales-reports/connect', requireUser, connectMyAuthorStoreSalesReports)
router.post('/me/sales-reports/sync', requireUser, syncMyAuthorStoreSalesReports)
router.delete('/me/sales-reports/disconnect', requireUser, disconnectMyAuthorStoreSalesReports)
router.put('/me/delivery-settings', requireUser, updateMyAuthorStoreDeliverySettings)
router.post('/me/categories', requireUser, createMyAuthorStoreCategory)
router.patch('/me/categories/reorder', requireUser, reorderMyAuthorStoreCategories)
router.delete('/me/categories/:categoryId', requireUser, deleteMyAuthorStoreCategory)
router.post('/me/products', requireUser, createMyAuthorStoreProduct)
router.post(
  '/me/pdfs/upload-private',
  requireUser,
  handlePrivatePdfUpload,
  cleanupPrivatePdfTemp,
  validateAuthorStorePdf,
  uploadMyAuthorStorePrivatePdf
)
router.delete('/me/pdfs/temporary', requireUser, deleteMyAuthorStoreTemporaryPdf)
router.patch(
  '/me/products/:productId/private-pdf',
  requireUser,
  attachMyAuthorStorePrivatePdf
)
router.get('/me/orders', requireUser, getMyAuthorStoreOrders)
router.patch('/me/orders/:orderId/preparing', requireUser, markMyAuthorStoreOrderPreparing)
router.get('/me/income', requireUser, getMyAuthorStoreIncome)
router.get('/me/earnings', requireUser, getMyAuthorStoreEarnings)
router.get('/me/book-pending', requireUser, getMyAuthorStoreBookPending)
router.post('/me/book-pending/:holdId/evidence', requireUser, submitMyAuthorStoreBookEvidence)
router.post('/me/withdrawals', requireUser, createMyAuthorStoreWithdrawal)
router.get('/admin/orders', requireAdmin, getAdminAuthorStoreOrders)
router.get('/admin/books/holds', requireAdmin, getAdminAuthorStoreBookHolds)
router.post('/admin/books/:orderId/approve-hold', requireAdmin, approveAdminAuthorStoreBookHold)
router.patch('/admin/orders/:orderId/status', requireAdmin, updateAdminAuthorStoreOrderStatus)
router.get('/admin/withdrawals', requireAdmin, getAdminAuthorStoreWithdrawals)
router.get('/admin/withdrawal-notifications', requireAdmin, getAdminAuthorStoreWithdrawalNotifications)
router.post('/admin/withdrawals/:withdrawalId/transfer-record', requireAdmin, recordAdminAuthorStoreTransfer)
router.post('/admin/withdrawals/:withdrawalId/receipt', requireAdmin, uploadAdminAuthorStoreReceipt)
router.get('/admin/withdrawals/:withdrawalId/receipt', requireAdmin, getAdminAuthorStoreReceipt)
router.patch('/admin/withdrawals/:withdrawalId/status', requireAdmin, updateAdminAuthorStoreWithdrawalStatus)

const authorBookCountryGate = (req, res, next) =>
  process.env.SHADOW_PHYSICAL_BOOKS_COUNTRY_ENFORCE === 'true'
    ? requireAuthorStorePhysicalBookCountry(req, res, next)
    : next()

const legacyAuthorBookCountryGate = (req, res, next) => {
  if (process.env.SHADOW_PHYSICAL_BOOKS_COUNTRY_ENFORCE !== 'true') return next()
  if (!req.get('authorization')) return requireAuthorStorePhysicalBookCountry(req, res, next)
  return requireUser(req, res, () => requireAuthorStorePhysicalBookCountry(req, res, next))
}

const createOrderIpLimit = createIpLimiter({
  key: 'author-store-order-create-ip',
  windowMs: 60 * 1000,
  max: 30,
})

router.post('/orders', createOrderIpLimit, legacyAuthorBookCountryGate, createAuthorStoreOrder)
router.post('/orders/create-payment', requireUser, authorBookCountryGate, createAuthorStoreOrderPayment)
router.get('/orders/my', requireUser, getMyAuthorStoreBuyerOrders)
router.get('/orders/book-holds/my', requireUser, getMyAuthorStoreBuyerBookHoldStatuses)
router.post('/orders/:orderId/confirm-received', requireUser, confirmMyAuthorStoreBookReceived)
router.get('/downloads/my', requireUser, getMyAuthorStoreReaderDownloads)
router.get('/downloads/:productId/offline-grant', requireUser, getMyAuthorStoreOfflinePdfGrant)
router.get('/downloads/:productId/pdf', requireUser, getMyAuthorStorePurchasedPdf)
router.get('/orders/status/:orderId', requireUser, getAuthorStoreOrderStatus)
router.post('/orders/callback', handleAuthorStoreAbaCallback)
router.put('/me/products/:productId', requireUser, updateMyAuthorStoreProduct)
router.delete('/me/products/:productId', requireUser, deleteMyAuthorStoreProduct)
router.get('/store/home', getReaderStoreHome)
router.get('/page/:pageUsername/products', getPublicAuthorStoreProducts)
router.post('/admin/orders/:orderId/resend-telegram', requireAdmin, resendAdminAuthorStoreOrderTelegram)
router.get('/admin/stores', requireAdmin, getAdminAuthorStoreStores)
router.get('/admin/stores/:authorPageId', requireAdmin, getAdminAuthorStoreStoreDetails)

router.use(authorStoreBookShipmentRoutes)
router.use(authorStoreBookProofRoutes)

export default router
