import express from 'express'
import {
  createAuthorPage,
  getMyAuthorPage,
  getPublicAuthorPage,
  updateAuthorAvatar,
  updateAuthorProfileImages,
} from '../controllers/authors.controller.js'
import {
  getMyAuthorIncome,
  getMyAuthorPaymentMethods,
  getMyAuthorQuest,
  saveMyAuthorPaymentMethod,
} from '../controllers/authorRevenue.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

router.get('/me', requireUser, getMyAuthorPage)
router.get('/me/quest', requireUser, getMyAuthorQuest)
router.get('/me/income', requireUser, getMyAuthorIncome)
router.get('/me/payment-methods', requireUser, getMyAuthorPaymentMethods)
router.get('/page/:pageUsername', getPublicAuthorPage)
router.post('/me/payment-methods', requireUser, saveMyAuthorPaymentMethod)
router.post('/create', requireUser, createAuthorPage)
router.put('/avatar', requireUser, updateAuthorAvatar)
router.put('/profile-images', requireUser, updateAuthorProfileImages)

export default router
