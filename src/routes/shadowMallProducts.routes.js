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
  getShadowMallOrderStatus,
  handleShadowMallAbaCallback,
} from '../controllers/shadowMallOrders.controller.js'

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

router.post('/orders/create-payment', requireUser, createShadowMallOrderPayment)
router.get('/orders/status/:orderId', requireUser, getShadowMallOrderStatus)
router.post('/orders/callback', handleShadowMallAbaCallback)

router.get('/products/:id', getShadowMallProductById)
router.post('/products', requireAdmin, upload.fields(shadowMallUploadFields), createShadowMallProduct)
router.put('/products/:id', requireAdmin, upload.fields(shadowMallUploadFields), updateShadowMallProduct)
router.delete('/products/:id', requireAdmin, deleteShadowMallProduct)

export default router
