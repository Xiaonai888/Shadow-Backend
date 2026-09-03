import express from 'express'
import multer from 'multer'
import os from 'node:os'
import { unlink } from 'node:fs/promises'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { requireUser } from '../middleware/user.middleware.js'
import {
  createShadowMallProduct,
  deleteShadowMallProduct,
  getShadowMallHome,
  getShadowMallProductById,
  getShadowMallProducts,
  updateShadowMallProduct,
} from '../controllers/shadowMallProducts.controller.js'
import {
  createAdminShadowMallPromotion,
  deleteAdminShadowMallPromotion,
  getAdminShadowMallPromotion,
  getAdminShadowMallPromotionById,
  getAdminShadowMallPromotions,
  getPublicShadowMallPromotion,
  getPublicShadowMallPromotions,
  reorderAdminShadowMallPromotions,
  updateAdminShadowMallPromotion,
  updateAdminShadowMallPromotionById,
  updateAdminShadowMallPromotionStatus,
} from '../controllers/shadowMallPromotion.controller.js'
import {
  createShadowMallPromotionComment,
  createShadowMallPromotionEcho,
  deleteOwnShadowMallPromotionComment,
  getShadowMallPromotionComments,
  getShadowMallPromotionEchoes,
  getShadowMallPromotionReactionStatus,
  getShadowMallPromotionSocialStatuses,
  setShadowMallPromotionReaction,
  toggleShadowMallPromotionCommentLike,
  updateOwnShadowMallPromotionComment,
} from '../controllers/shadowMallPromotionSocial.controller.js'
import {
  getShadowMallStorySaleStatus,
  getShadowMallStorySaleStatuses,
  purchaseShadowMallStory,
} from '../controllers/shadowMallStorySales.controller.js'
import {
  getShadowMallBuyerProfile,
  saveShadowMallBuyerProfile,
} from '../controllers/shadowMallBuyerProfiles.controller.js'
import {
  createShadowMallOrderPayment,
  getAdminShadowMallOrders,
  getMyShadowMallOrders,
  getShadowMallOrderStatus,
  handleShadowMallAbaCallback,
  updateAdminShadowMallOrderStatus,
} from '../controllers/shadowMallOrders.controller.js'
import {
  addShadowMallWishlist,
  getShadowMallWishlist,
  removeShadowMallWishlist,
} from '../controllers/shadowMallWishlists.controller.js'
import {
  assignShadowMallPublisherProducts,
  autoMatchShadowMallPublisherProducts,
  createShadowMallPublisher,
  deleteShadowMallPublisher,
  getShadowMallPublisherLogs,
  getShadowMallPublisherProducts,
  getShadowMallPublishers,
  removeShadowMallPublisherProducts,
  updateShadowMallPublisher,
} from '../controllers/shadowMallPublishers.controller.js'

const router = express.Router()

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 6,
  },
})

const shadowMallUploadFields = [
  { name: 'main_cover', maxCount: 1 },
  { name: 'gallery_image_0', maxCount: 1 },
  { name: 'gallery_image_1', maxCount: 1 },
  { name: 'gallery_image_2', maxCount: 1 },
  { name: 'gallery_image_3', maxCount: 1 },
  { name: 'gallery_image_4', maxCount: 1 },
]

const shadowMallPromotionUploadFields = [
  { name: 'promotion_image', maxCount: 1 },
  { name: 'profile_image', maxCount: 1 },
]

function tempFiles(req) {
  const paths = []

  if (req.file?.path) {
    paths.push(req.file.path)
  }

  if (Array.isArray(req.files)) {
    for (const file of req.files) {
      if (file?.path) paths.push(file.path)
    }
  } else if (req.files && typeof req.files === 'object') {
    for (const values of Object.values(req.files)) {
      for (const file of Array.isArray(values) ? values : []) {
        if (file?.path) paths.push(file.path)
      }
    }
  }

  return [...new Set(paths)]
}

async function removeTempFiles(req) {
  await Promise.all(
    tempFiles(req).map((filePath) =>
      unlink(filePath).catch(() => {})
    )
  )
}

function cleanupTempFiles(req, res, next) {
  let cleaned = false

  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    removeTempFiles(req).catch(() => {})
  }

  res.once('finish', cleanup)
  res.once('close', cleanup)
  next()
}

function runUpload(handler) {
  return (req, res, next) => {
    handler(req, res, (error) => {
      if (!error) return next()

      removeTempFiles(req).catch(() => {})

      const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400
      const message =
        error.code === 'LIMIT_FILE_SIZE'
          ? 'Each file must be 5 MB or smaller'
          : error.message || 'Invalid file upload'

      return res.status(status).json({
        ok: false,
        message,
      })
    })
  }
}

router.get('/home', getShadowMallHome)
router.get('/promotion', getPublicShadowMallPromotion)
router.get('/promotions', getPublicShadowMallPromotions)
router.get('/products', getShadowMallProducts)

router.get(
  '/promotions/story-sale/statuses',
  requireUser,
  getShadowMallStorySaleStatuses
)

router.get(
  '/promotions/:promotionId/story-sale/status',
  requireUser,
  getShadowMallStorySaleStatus
)
router.post(
  '/promotions/:promotionId/story-sale/purchase',
  requireUser,
  purchaseShadowMallStory
)
router.get(
  '/promotions/social-statuses',
  requireUser,
  getShadowMallPromotionSocialStatuses
)

router.get(
  '/promotions/:promotionId/reaction',
  requireUser,
  getShadowMallPromotionReactionStatus
)
router.post(
  '/promotions/:promotionId/reaction',
  requireUser,
  setShadowMallPromotionReaction
)
router.get(
  '/promotions/:promotionId/comments',
  requireUser,
  getShadowMallPromotionComments
)
router.post(
  '/promotions/:promotionId/comments',
  requireUser,
  createShadowMallPromotionComment
)
router.patch(
  '/promotion-comments/:commentId',
  requireUser,
  updateOwnShadowMallPromotionComment
)
router.delete(
  '/promotion-comments/:commentId',
  requireUser,
  deleteOwnShadowMallPromotionComment
)
router.post(
  '/promotion-comments/:commentId/like',
  requireUser,
  toggleShadowMallPromotionCommentLike
)
router.get(
  '/promotions/:promotionId/echoes',
  requireUser,
  getShadowMallPromotionEchoes
)
router.post(
  '/promotions/:promotionId/echoes',
  requireUser,
  createShadowMallPromotionEcho
)

router.get(
  '/admin/promotion',
  requireAdmin,
  getAdminShadowMallPromotion
)
router.put(
  '/admin/promotion',
  requireAdmin,
  runUpload(upload.fields(shadowMallPromotionUploadFields)),
  cleanupTempFiles,
  updateAdminShadowMallPromotion
)

router.get(
  '/admin/promotions',
  requireAdmin,
  getAdminShadowMallPromotions
)
router.post(
  '/admin/promotions',
  requireAdmin,
  runUpload(upload.fields(shadowMallPromotionUploadFields)),
  cleanupTempFiles,
  createAdminShadowMallPromotion
)
router.patch(
  '/admin/promotions/reorder',
  requireAdmin,
  reorderAdminShadowMallPromotions
)
router.get(
  '/admin/promotions/:id',
  requireAdmin,
  getAdminShadowMallPromotionById
)
router.put(
  '/admin/promotions/:id',
  requireAdmin,
  runUpload(upload.fields(shadowMallPromotionUploadFields)),
  cleanupTempFiles,
  updateAdminShadowMallPromotionById
)
router.patch(
  '/admin/promotions/:id/status',
  requireAdmin,
  updateAdminShadowMallPromotionStatus
)
router.delete(
  '/admin/promotions/:id',
  requireAdmin,
  deleteAdminShadowMallPromotion
)

router.get('/publishers', getShadowMallPublishers)
router.get(
  '/admin/publishers/logs',
  requireAdmin,
  getShadowMallPublisherLogs
)
router.post(
  '/admin/publishers',
  requireAdmin,
  runUpload(upload.single('publisher_logo')),
  cleanupTempFiles,
  createShadowMallPublisher
)
router.put(
  '/admin/publishers/:id',
  requireAdmin,
  runUpload(upload.single('publisher_logo')),
  cleanupTempFiles,
  updateShadowMallPublisher
)
router.delete(
  '/admin/publishers/:id',
  requireAdmin,
  deleteShadowMallPublisher
)
router.get(
  '/admin/publishers/:id/products',
  requireAdmin,
  getShadowMallPublisherProducts
)
router.get(
  '/admin/publishers/:id/auto-match',
  requireAdmin,
  autoMatchShadowMallPublisherProducts
)
router.post(
  '/admin/publishers/:id/assign-products',
  requireAdmin,
  assignShadowMallPublisherProducts
)
router.post(
  '/admin/publishers/:id/remove-products',
  requireAdmin,
  removeShadowMallPublisherProducts
)

router.get(
  '/buyer-profile',
  requireUser,
  getShadowMallBuyerProfile
)
router.put(
  '/buyer-profile',
  requireUser,
  saveShadowMallBuyerProfile
)

router.get(
  '/wishlist',
  requireUser,
  getShadowMallWishlist
)
router.post(
  '/wishlist/:productId',
  requireUser,
  addShadowMallWishlist
)
router.delete(
  '/wishlist/:productId',
  requireUser,
  removeShadowMallWishlist
)

router.get(
  '/admin/orders',
  requireAdmin,
  getAdminShadowMallOrders
)
router.patch(
  '/admin/orders/:orderId/status',
  requireAdmin,
  updateAdminShadowMallOrderStatus
)

router.post(
  '/orders/create-payment',
  requireUser,
  createShadowMallOrderPayment
)
router.get(
  '/orders/my',
  requireUser,
  getMyShadowMallOrders
)
router.get(
  '/orders/status/:orderId',
  requireUser,
  getShadowMallOrderStatus
)
router.post(
  '/orders/callback',
  handleShadowMallAbaCallback
)

router.get(
  '/products/:id',
  getShadowMallProductById
)
router.post(
  '/products',
  requireAdmin,
  runUpload(upload.fields(shadowMallUploadFields)),
  cleanupTempFiles,
  createShadowMallProduct
)
router.put(
  '/products/:id',
  requireAdmin,
  runUpload(upload.fields(shadowMallUploadFields)),
  cleanupTempFiles,
  updateShadowMallProduct
)
router.delete(
  '/products/:id',
  requireAdmin,
  deleteShadowMallProduct
)

export default router
