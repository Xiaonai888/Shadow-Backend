import express from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  getAdminAuthorReviews,
  moderateAdminAuthorReview,
} from '../controllers/adminAuthorReviews.controller.js'

const router = express.Router()

const adminReviewIdentity = (req) => String(
  req.admin?.admin_id ||
  req.admin?.id ||
  req.admin?.sub ||
  req.admin?.email ||
  ipKeyGenerator(req.ip)
)

const adminReviewReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 180,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: adminReviewIdentity,
  message: {
    ok: false,
    code: 'ADMIN_AUTHOR_REVIEWS_READ_RATE_LIMIT',
    message: 'Too many review requests. Please retry shortly.',
  },
})

const adminReviewWriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: adminReviewIdentity,
  message: {
    ok: false,
    code: 'ADMIN_AUTHOR_REVIEWS_WRITE_RATE_LIMIT',
    message: 'Too many review changes. Please retry shortly.',
  },
})

router.get('/', requireAdmin, adminReviewReadLimit, getAdminAuthorReviews)
router.patch('/:reviewId', requireAdmin, adminReviewWriteLimit, moderateAdminAuthorReview)

export default router
