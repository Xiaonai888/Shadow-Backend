import express from 'express'
import {
  createAuthorStoreOrder,
  createMyAuthorStoreCategory,
  createMyAuthorStoreProduct,
  deleteMyAuthorStoreCategory,
  getMyAuthorStoreCategories,
  getMyAuthorStoreOrders,
  getMyAuthorStoreProducts,
  getPublicAuthorStoreProducts,
  reorderMyAuthorStoreCategories,
} from '../controllers/authorStore.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

router.get('/me/products', requireUser, getMyAuthorStoreProducts)
router.post('/me/products', requireUser, createMyAuthorStoreProduct)
router.get('/me/orders', requireUser, getMyAuthorStoreOrders)
router.post('/orders', createAuthorStoreOrder)
router.put('/me/products/:productId', requireUser, updateMyAuthorStoreProduct)
router.delete('/me/products/:productId', requireUser, deleteMyAuthorStoreProduct)
router.get('/page/:pageUsername/products', getPublicAuthorStoreProducts)

export default router
