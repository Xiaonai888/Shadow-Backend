import express from 'express'
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
} from '../controllers/authorStore.controller.js'
import { requireUser } from '../middleware/user.middleware.js'
import { requireAdmin } from '../middleware/auth.middleware.js'

const router = express.Router()

router.get('/me/products', requireUser, getMyAuthorStoreProducts)
router.get('/me/categories', requireUser, getMyAuthorStoreCategories)
router.get('/me/delivery-settings', requireUser, getMyAuthorStoreDeliverySettings)
router.post('/telegram/webhook', handleAuthorStoreTelegramWebhook)
router.get('/me/telegram-settings', requireUser, getMyAuthorStoreTelegramSettings)
router.post('/me/telegram-settings/connect-link', requireUser, createMyAuthorStoreTelegramConnectLink)
router.post('/me/telegram-settings/unlink', requireUser, unlinkMyAuthorStoreTelegramGroup)
router.put('/me/delivery-settings', requireUser, updateMyAuthorStoreDeliverySettings)
router.post('/me/categories', requireUser, createMyAuthorStoreCategory)
router.patch('/me/categories/reorder', requireUser, reorderMyAuthorStoreCategories)
router.patch('/me/categories/:categoryId', requireUser, updateMyAuthorStoreCategory)
router.delete('/me/categories/:categoryId', requireUser, deleteMyAuthorStoreCategory)
router.post('/me/products', requireUser, createMyAuthorStoreProduct)
router.get('/me/orders', requireUser, getMyAuthorStoreOrders)
router.get('/me/income', requireUser, getMyAuthorStoreIncome)
router.post('/me/withdrawals', requireUser, createMyAuthorStoreWithdrawal)
router.get('/admin/orders', requireAdmin, getAdminAuthorStoreOrders)
router.patch('/admin/orders/:orderId/status', requireAdmin, updateAdminAuthorStoreOrderStatus)
router.get('/admin/withdrawals', requireAdmin, getAdminAuthorStoreWithdrawals)
router.patch('/admin/withdrawals/:withdrawalId/status', requireAdmin, updateAdminAuthorStoreWithdrawalStatus)
router.post('/orders', createAuthorStoreOrder)
router.post('/orders/create-payment', requireUser, createAuthorStoreOrderPayment)
router.get('/orders/my', requireUser, getMyAuthorStoreBuyerOrders)
router.get('/orders/status/:orderId', requireUser, getAuthorStoreOrderStatus)
router.post('/orders/callback', handleAuthorStoreAbaCallback)
router.put('/me/products/:productId', requireUser, updateMyAuthorStoreProduct)
router.delete('/me/products/:productId', requireUser, deleteMyAuthorStoreProduct)
router.get('/page/:pageUsername/products', getPublicAuthorStoreProducts)
router.post('/admin/orders/:orderId/resend-telegram', requireAdmin, resendAdminAuthorStoreOrderTelegram)


export default router
