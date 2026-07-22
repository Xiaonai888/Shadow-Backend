import express from 'express'
import {
  getAdminCommentTrash,
  getMyAuthorCommentTrash,
  recoverAdminTrashComment,
  recoverMyAuthorTrashComment,
} from '../controllers/commentTrash.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

router.get('/author', requireUser, getMyAuthorCommentTrash)
router.patch(
  '/author/:source/:commentId/recover',
  requireUser,
  recoverMyAuthorTrashComment
)
router.get('/admin', requireAdmin, getAdminCommentTrash)
router.patch(
  '/admin/:source/:commentId/recover',
  requireAdmin,
  recoverAdminTrashComment
)

export default router
