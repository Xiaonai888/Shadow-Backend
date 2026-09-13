import express from 'express'
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

router.get('/stories', requireAdmin, searchAdminCommentStories)
router.get('/story/:storyId', requireAdmin, getAdminStoryComments)
router.get('/records', requireAdmin, getAdminCommentOwnerReports)
router.get('/', requireAdmin, getAdminComments)
router.patch(
  '/:commentId/moderate',
  requireAdmin,
  invalidatePublicStoriesAfterCommentCountChange,
  moderateAdminComment
)
router.delete(
  '/:commentId',
  requireAdmin,
  invalidatePublicStoriesAfterCommentCountChange,
  deleteAdminComment
)
router.post('/:commentId/ban-user', requireAdmin, banAdminCommentUser)

export default router
