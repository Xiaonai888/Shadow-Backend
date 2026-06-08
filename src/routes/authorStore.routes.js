import express from 'express'
import {
  createMyAuthorStoreProduct,
  getMyAuthorStoreProducts,
  getPublicAuthorStoreProducts,
} from '../controllers/authorStore.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

router.get('/me/products', requireUser, getMyAuthorStoreProducts)
router.post('/me/products', requireUser, createMyAuthorStoreProduct)
router.get('/page/:pageUsername/products', getPublicAuthorStoreProducts)

export default router
