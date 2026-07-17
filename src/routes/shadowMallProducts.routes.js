import express from 'express'
import multer from 'multer'
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
  storage: multer.memoryStorage(),
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

router.get('/home', getShadowMallHome)
router.get('/promotion', getPublicShadowMallPromotion)
router.get('/promotions', getPublicShadowMallPromotions)
router.get('/products', getShadowMallProducts)

router.get(
  '/admin/promotion',
  requireAdmin,
  getAdminShadowMallPromotion
)
router.put(
  '/admin/promotion',
  requireAdmin,
  upload.fields(shadowMallPromotionUploadFields),
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
  upload.fields(shadowMallPromotionUploadFields),
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
  upload.fields(shadowMallPromotionUploadFields),
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
  upload.single('publisher_logo'),
  createShadowMallPublisher
)
router.put(
  '/admin/publishers/:id',
  requireAdmin,
  upload.single('publisher_logo'),
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
  upload.fields(shadowMallUploadFields),
  createShadowMallProduct
)
router.put(
  '/products/:id',
  requireAdmin,
  upload.fields(shadowMallUploadFields),
  updateShadowMallProduct
)
router.delete(
  '/products/:id',
  requireAdmin,
  deleteShadowMallProduct
)

export default router
