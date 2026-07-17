import express from 'express'
import {
  createMyReaderPost,
  deleteMyReaderPost,
  getMyReaderPosts,
  getReaderPostsByUsername,
  getReaderPostsFeed,
  updateMyReaderPost,
} from '../controllers/readerPosts.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

router.get('/feed', requireUser, getReaderPostsFeed)
router.get('/me', requireUser, getMyReaderPosts)
router.post('/me', requireUser, createMyReaderPost)
router.patch('/me/:postId', requireUser, updateMyReaderPost)
router.delete('/me/:postId', requireUser, deleteMyReaderPost)
router.get(
  '/user/:username',
  requireUser,
  getReaderPostsByUsername
)

export default router
