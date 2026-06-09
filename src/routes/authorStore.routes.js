import express from 'express'
import {
  createAuthorStoreOrder,
  createAuthorStoreOrderPayment,
  createMyAuthorStoreCategory,
  createMyAuthorStoreProduct,
  deleteMyAuthorStoreCategory,
  deleteMyAuthorStoreProduct,
  getAuthorStoreOrderStatus,
  getMyAuthorStoreBuyerOrders,
  getMyAuthorStoreCategories,
  getMyAuthorStoreOrders,
  getMyAuthorStoreProducts,
  getPublicAuthorStoreProducts,
  handleAuthorStoreAbaCallback,
  reorderMyAuthorStoreCategories,
  updateMyAuthorStoreCategory,
  updateMyAuthorStoreProduct,
} from '../controllers/authorStore.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

router.get('/me/products', requireUser, getMyAuthorStoreProducts)
router.get('/me/categories', requireUser, getMyAuthorStoreCategories)
router.post('/me/categories', requireUser, createMyAuthorStoreCategory)
router.patch('/me/categories/reorder', requireUser, reorderMyAuthorStoreCategories)
router.patch('/me/categories/:categoryId', requireUser, updateMyAuthorStoreCategory)
router.delete('/me/categories/:categoryId', requireUser, deleteMyAuthorStoreCategory)
router.post('/me/products', requireUser, createMyAuthorStoreProduct)
router.get('/me/orders', requireUser, getMyAuthorStoreOrders)
router.post('/orders', createAuthorStoreOrder)
router.post('/orders/create-payment', requireUser, createAuthorStoreOrderPayment)
router.get('/orders/my', requireUser, getMyAuthorStoreBuyerOrders)
router.get('/orders/status/:orderId', requireUser, getAuthorStoreOrderStatus)
router.post('/orders/callback', handleAuthorStoreAbaCallback)
router.put('/me/products/:productId', requireUser, updateMyAuthorStoreProduct)
router.delete('/me/products/:productId', requireUser, deleteMyAuthorStoreProduct)
router.get('/page/:pageUsername/products', getPublicAuthorStoreProducts)

export default router
