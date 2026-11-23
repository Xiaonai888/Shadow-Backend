import { getReaderStoreHome } from '../controllers/readerStore.controller.js'
import { supabase } from '../config/supabase.js'
import { requirePaymentCountry } from '../middleware/paymentCountryGate.middleware.js'
import { getMyAuthorStoreEarnings } from '../controllers/authorStoreEarnings.controller.js'
import { getMyAuthorStoreBookPending, confirmMyAuthorStoreBookReceived } from '../controllers/authorStoreBookPending.controller.js'
import { submitMyAuthorStoreBookEvidence, getMyAuthorStoreBuyerBookHoldStatuses, getAdminAuthorStoreBookHolds } from '../controllers/authorStoreBookWorkflow.controller.js'
import { approveAdminAuthorStoreBookHold } from '../controllers/adminAuthorStoreBookApproval.controller.js'
import express from 'express'
import multer from 'multer'
import os from 'node:os'
import { unlink } from 'node:fs/promises'
import { getMyAuthorStoreOfflinePdfGrant, getMyAuthorStorePurchasedPdf } from '../controllers/authorStoreOfflinePdf.controller.js'
import { requireUnpurchasedAuthorStorePdf } from '../middleware/authorStorePdfCheckoutGuard.middleware.js'
import { getMyAuthorStorePdfOwnership } from '../controllers/authorStorePdfOwnership.controller.js'
import { recheckMyAuthorStorePdfPayment } from '../controllers/authorStorePdfPaymentRecovery.controller.js'
import {
  createAuthorStoreOrder,
  createAuthorStoreOrderPayment,
  createAuthorStoreBinancePdfCheckout,
  getAuthorStoreBinancePdfCheckout,
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
import {
  isReaderClassificationCountryPolicyEnabled,
  readReaderClassificationCountry,
} from '../services/readerClassificationCountrySource.service.js'
import { createRateLimit as createIpLimiter } from '../middleware/rateLimit.middleware.js'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { getAdminAuthorStoreWithdrawalNotifications } from '../controllers/adminAuthorStoreWithdrawalNotifications.controller.js'
import { validateAuthorStorePdf, deleteMyAuthorStoreTemporaryPdf } from '../controllers/authorStorePdfGuard.controller.js'
import authorStoreBookProofRoutes from './authorStoreBookProof.routes.js'
import authorStoreBookShipmentRoutes from './authorStoreBookShipment.routes.js'
import authorStoreCustomDeliveryRoutes from './authorStoreCustomDelivery.routes.js'

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
  isReaderClassificationCountryPolicyEnabled()
    ? requireAuthorStorePhysicalBookCountry(req, res, next)
    : next()

const legacyAuthorBookCountryGate = (req, res, next) => {
  if (!isReaderClassificationCountryPolicyEnabled()) return next()
  if (!req.get('authorization')) return requireAuthorStorePhysicalBookCountry(req, res, next)
  return requireUser(req, res, () => requireAuthorStorePhysicalBookCountry(req, res, next))
}

const createOrderIpLimit = createIpLimiter({
  key: 'author-store-order-create-ip',
  windowMs: 60 * 1000,
  max: 30,
})

// Keep Binance checkout status polling available without giving write operations
// a higher limit. Both limiters are IP-based and run before authentication.
const binancePdfStatusIpLimit = createIpLimiter({
  key: 'author-store-binance-pdf-status-ip',
  windowMs: 60 * 1000,
  max: 120,
})

const pdfPaymentRecheckIpLimit = createIpLimiter({
  key: 'author-store-pdf-payment-recheck-ip',
  windowMs: 60 * 1000,
  max: 6,
})

const createPaymentUserLimit = createIpLimiter({
  key: 'author-store-create-payment-user',
  windowMs: 60 * 1000,
  max: 10,
  identity: (req) => req.user?.user_id ? `user:${req.user.user_id}` : null,
})

const pdfOwnershipIpLimit = createIpLimiter({
  key: 'author-store-pdf-ownership-ip',
  windowMs: 60 * 1000,
  max: 60,
})

router.post('/orders', createOrderIpLimit, legacyAuthorBookCountryGate, createAuthorStoreOrder)
// Use actual product types from the DB, never client-supplied 'product_type'.
const authorStoreDigitalCountryGate = async (req, res, next) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : []

    const ids = [...new Set(
      items
        .map(item => String(item?.id || item?.product_id || item?.productId || '').trim())
        .filter(Boolean)
    )]

    if (!ids.length || ids.length > 30) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_CART',
        message: 'Invalid cart items',
      })
    }

    const { data, error } = await supabase
      .from('author_store_products')
      .select('id,product_type')
      .in('id', ids)

    if (error) throw error

    if (!Array.isArray(data) || data.length !== ids.length) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_CART_PRODUCTS',
        message: 'Invalid cart products',
      })
    }

    const hasBook = data.some(
      item => String(item.product_type || '').toLowerCase() !== 'pdf'
    )

    const hasPdf = data.some(
      item => String(item.product_type || '').toLowerCase() === 'pdf'
    )

    if (hasBook && !isReaderClassificationCountryPolicyEnabled()) {
      const userId = req.user?.user_id
      const savedCountry = await readReaderClassificationCountry(userId)

      if (savedCountry?.verified !== true) {
        return res.status(403).json({
          ok: false,
          code: 'BOOK_COUNTRY_REQUIRED',
          message: 'A verified country is required to purchase printed books',
        })
      }

      const { data: exception, error: exceptionError } = await supabase
        .from('shadow_country_user_exceptions')
        .select('mode,overrides,expires_at')
        .eq('user_id', userId)
        .maybeSingle()

      if (exceptionError) throw exceptionError

      const activeException = exception &&
        (!exception.expires_at || Date.parse(exception.expires_at) > Date.now())
          ? exception
          : null

      const blockedByAdmin =
        activeException?.mode === 'custom' &&
        (
          activeException.overrides?.physicalBooks === 'block' ||
          activeException.overrides?.payway === 'block'
        )

      const allowedByException = Boolean(
        activeException &&
        (
          activeException.mode === 'all_eligible' ||
          activeException.mode === 'cambodia_experience' ||
          (
            activeException.mode === 'custom' &&
            activeException.overrides?.physicalBooks === 'allow'
          )
        )
      )

      if (
        blockedByAdmin ||
        (savedCountry.country !== 'KH' && !allowedByException)
      ) {
        return res.status(403).json({
          ok: false,
          code: 'BOOK_COUNTRY_BLOCKED',
          message: 'Printed books are unavailable for your country',
        })
      }
    }

    if (hasPdf) {
      return requirePaymentCountry('pdfPayway')(req, res, next)
    }

    return next()
  } catch (error) {
    console.error(
      'AUTHOR STORE CHECKOUT COUNTRY ERROR:',
      String(error?.message || error)
    )

    return res.status(503).json({
      ok: false,
      code: 'CHECKOUT_COUNTRY_UNAVAILABLE',
      message: 'Could not verify checkout country permissions',
    })
  }
}

router.post('/orders/create-payment', createOrderIpLimit, requireUser, createPaymentUserLimit, authorBookCountryGate, authorStoreDigitalCountryGate, requireUnpurchasedAuthorStorePdf, createAuthorStoreOrderPayment)
router.post('/orders/binance-pdf/checkout', createOrderIpLimit, requireUser,
  requirePaymentCountry('pdfBinancePay'), requireUnpurchasedAuthorStorePdf, createAuthorStoreBinancePdfCheckout)
router.get('/orders/binance-pdf/:purchaseId', binancePdfStatusIpLimit, requireUser, getAuthorStoreBinancePdfCheckout)
router.get('/orders/my', requireUser, getMyAuthorStoreBuyerOrders)
router.get('/orders/book-holds/my', requireUser, getMyAuthorStoreBuyerBookHoldStatuses)
router.post('/orders/:orderId/confirm-received', requireUser, confirmMyAuthorStoreBookReceived)
router.get('/downloads/my', requireUser, getMyAuthorStoreReaderDownloads)
router.get('/downloads/:productId/offline-grant', requireUser, getMyAuthorStoreOfflinePdfGrant)
router.get('/downloads/:productId/pdf', requireUser, getMyAuthorStorePurchasedPdf)
router.get('/orders/pdf-ownership', pdfOwnershipIpLimit, requireUser, getMyAuthorStorePdfOwnership)
router.post('/orders/:orderId/recheck-pdf-payment', pdfPaymentRecheckIpLimit, requireUser, recheckMyAuthorStorePdfPayment)
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
router.use(authorStoreCustomDeliveryRoutes)

export default router
