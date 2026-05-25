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

router.get('/home', getShadowMallHome)
router.get('/products', getShadowMallProducts)

router.get('/buyer-profile', requireUser, getShadowMallBuyerProfile)
router.put('/buyer-profile', requireUser, saveShadowMallBuyerProfile)

router.get('/wishlist', requireUser, getShadowMallWishlist)
router.post('/wishlist/:productId', requireUser, addShadowMallWishlist)
router.delete('/wishlist/:productId', requireUser, removeShadowMallWishlist)

router.get('/admin/orders', requireAdmin, getAdminShadowMallOrders)
router.patch('/admin/orders/:orderId/status', requireAdmin, updateAdminShadowMallOrderStatus)

router.post('/orders/create-payment', requireUser, createShadowMallOrderPayment)
router.get('/orders/my', requireUser, getMyShadowMallOrders)
router.get('/orders/status/:orderId', requireUser, getShadowMallOrderStatus)
router.post('/orders/callback', handleShadowMallAbaCallback)

router.get('/products/:id', getShadowMallProductById)
router.post('/products', requireAdmin, upload.fields(shadowMallUploadFields), createShadowMallProduct)
router.put('/products/:id', requireAdmin, upload.fields(shadowMallUploadFields), updateShadowMallProduct)
router.delete('/products/:id', requireAdmin, deleteShadowMallProduct)

export default router
