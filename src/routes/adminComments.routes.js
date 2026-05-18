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

const router = express.Router()

router.get('/stories', requireAdmin, searchAdminCommentStories)
router.get('/story/:storyId', requireAdmin, getAdminStoryComments)
router.get('/records', requireAdmin, getAdminCommentOwnerReports)
router.get('/', requireAdmin, getAdminComments)
router.patch('/:commentId/moderate', requireAdmin, moderateAdminComment)
router.delete('/:commentId', requireAdmin, deleteAdminComment)
router.post('/:commentId/ban-user', requireAdmin, banAdminCommentUser)

export default router
