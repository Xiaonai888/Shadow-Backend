import express from 'express'
import {
  updateMyAuthorPage,
  createAuthorPage,
  followAuthorPage,
  getFollowedAuthorPages,
  getMyAuthorPage,
  getPublicAuthorPage,
  getTopAuthorPages,
  unfollowAuthorPage,
  updateAuthorAvatar,
  updateAuthorProfileImages,
} from '../controllers/authors.controller.js'
import {
  createMyAuthorPost,
  getAuthorPagePosts,
  setMyAuthorPostPinned,
} from '../controllers/authorPosts.controller.js'
import {
  getMyAuthorIncome,
  getMyAuthorPaymentMethods,
  getMyAuthorQuest,
  saveMyAuthorPaymentMethod,
} from '../controllers/authorRevenue.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

import {
  getMyAuthorPageNotifications,
  markAllMyAuthorPageNotificationsRead,
  markMyAuthorPageNotificationRead,
} from '../controllers/authorPageNotifications.controller.js'


const router = express.Router()

router.get('/me', requireUser, getMyAuthorPage)
router.get('/me/quest', requireUser, getMyAuthorQuest)
router.get('/me/income', requireUser, getMyAuthorIncome)
router.get('/me/payment-methods', requireUser, getMyAuthorPaymentMethods)
router.get('/me/page-notifications', requireUser, getMyAuthorPageNotifications)
router.patch('/me/page-notifications/read-all', requireUser, markAllMyAuthorPageNotificationsRead)
router.patch('/me/page-notifications/:id/read', requireUser, markMyAuthorPageNotificationRead)
router.get('/following', requireUser, getFollowedAuthorPages)
router.get('/top', getTopAuthorPages)
router.get('/page/:pageUsername', getPublicAuthorPage)
router.post('/page/:pageUsername/follow', requireUser, followAuthorPage)
router.delete('/page/:pageUsername/follow', requireUser, unfollowAuthorPage)
router.post('/me/payment-methods', requireUser, saveMyAuthorPaymentMethod)
router.post('/create', requireUser, createAuthorPage)
router.put('/avatar', requireUser, updateAuthorAvatar)
router.put('/profile-images', requireUser, updateAuthorProfileImages)
router.put('/me', requireUser, updateMyAuthorPage)
router.get('/page/:pageUsername/posts', getAuthorPagePosts)
router.post('/me/posts', requireUser, createMyAuthorPost)
router.patch('/me/posts/:postId/pin', requireUser, setMyAuthorPostPinned)


export default router
