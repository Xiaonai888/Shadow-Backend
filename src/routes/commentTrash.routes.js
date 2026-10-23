import express from 'express'
import { rateLimit } from 'express-rate-limit'
import {
  getAdminCommentTrash,
  getMyAuthorCommentTrash,
  recoverAdminTrashComment,
  recoverMyAuthorTrashComment,
} from '../controllers/commentTrash.controller.js'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

const commentTrashReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'COMMENT_TRASH_READ_RATE_LIMIT',
    message: 'Too many comment trash requests. Please retry shortly.',
  },
})

const commentTrashRecoverLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'COMMENT_TRASH_RECOVER_RATE_LIMIT',
    message: 'Too many comment restore requests. Please retry shortly.',
  },
})

router.get('/author', commentTrashReadLimit, requireUser, getMyAuthorCommentTrash)
router.patch(
  '/author/:source/:commentId/recover',
  commentTrashRecoverLimit,
  requireUser,
  recoverMyAuthorTrashComment
)
router.get('/admin', commentTrashReadLimit, requireAdmin, getAdminCommentTrash)
router.patch(
  '/admin/:source/:commentId/recover',
  commentTrashRecoverLimit,
  requireAdmin,
  recoverAdminTrashComment
)

export default router
