import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  getAdminAuthorReviews,
  moderateAdminAuthorReview,
} from '../controllers/adminAuthorReviews.controller.js'

const router = express.Router()

router.get('/', requireAdmin, getAdminAuthorReviews)
router.patch('/:reviewId', requireAdmin, moderateAdminAuthorReview)

export default router
