import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  banAdminCommentUser,
  deleteAdminComment,
  getAdminCommentOwnerReports,
  getAdminComments,
  getAdminStoryComments,
  moderateAdminComment,
  searchAdminCommentStories,
} from '../controllers/adminComments.controller.js'
import { invalidatePublicStoriesCache } from '../services/publicStoriesResponseCache.service.js'

const router = express.Router()

const adminCommentsReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'ADMIN_COMMENTS_READ_RATE_LIMIT',
    message: 'Too many admin comment requests. Please retry shortly.',
  },
})

const adminCommentsWriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'ADMIN_COMMENTS_WRITE_RATE_LIMIT',
    message: 'Too many admin comment actions. Please retry shortly.',
  },
})

function invalidatePublicStoriesAfterCommentCountChange(req, res, next) {
  const action = String(req.body?.action || '')
    .trim()
    .toLowerCase()

  const shouldInvalidate =
    req.method === 'DELETE' ||
    action === 'hide' ||
    action === 'unhide'

  if (shouldInvalidate) {
    res.once('finish', () => {
      if (
        res.statusCode >= 200 &&
        res.statusCode < 300
      ) {
        invalidatePublicStoriesCache()
      }
    })
  }

  next()
}

router.get('/stories', adminCommentsReadLimit, requireAdmin, searchAdminCommentStories)
router.get('/story/:storyId', adminCommentsReadLimit, requireAdmin, getAdminStoryComments)
router.get('/records', adminCommentsReadLimit, requireAdmin, getAdminCommentOwnerReports)
router.get('/', adminCommentsReadLimit, requireAdmin, getAdminComments)
router.patch(
  '/:commentId/moderate',
  adminCommentsWriteLimit,
  requireAdmin,
  invalidatePublicStoriesAfterCommentCountChange,
  moderateAdminComment
)
router.delete(
  '/:commentId',
  adminCommentsWriteLimit,
  requireAdmin,
  invalidatePublicStoriesAfterCommentCountChange,
  deleteAdminComment
)
router.post('/:commentId/ban-user', adminCommentsWriteLimit, requireAdmin, banAdminCommentUser)

export default router
