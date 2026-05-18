import express from 'express'
import { requireAdmin } from '../middleware/auth.middleware.js'
import {
  banAdminCommentUser,
  deleteAdminComment,
  getAdminCommentOwnerReports,
  getAdminComments,
  moderateAdminComment,
} from '../controllers/adminComments.controller.js'

const router = express.Router()

router.get('/', requireAdmin, getAdminComments)
router.get('/records', requireAdmin, getAdminCommentOwnerReports)
router.patch('/:commentId/moderate', requireAdmin, moderateAdminComment)
router.delete('/:commentId', requireAdmin, deleteAdminComment)
router.post('/:commentId/ban-user', requireAdmin, banAdminCommentUser)

export default router
