import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  createShadowMallProduct,
  deleteShadowMallProduct,
  getShadowMallHome,
  getShadowMallProductById,
  getShadowMallProducts,
  updateShadowMallProduct,
} from '../controllers/shadowMallProducts.controller.js'

const router = express.Router()

router.get('/home', getShadowMallHome)
router.get('/products', getShadowMallProducts)
router.get('/products/:id', getShadowMallProductById)
router.post('/products', requireAdmin, createShadowMallProduct)
router.put('/products/:id', requireAdmin, updateShadowMallProduct)
router.delete('/products/:id', requireAdmin, deleteShadowMallProduct)

export default router
