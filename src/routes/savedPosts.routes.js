import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { requireUser } from '../middleware/user.middleware.js'
import {
  createSavedPostCollection,
  deleteSavedPostCollection,
  getSavedPostCollections,
  getSavedPostStatus,
  getSavedPosts,
  removeSavedPost,
  removeSavedPostBySource,
  replaceSavedPostCollections,
  savePost,
  updateSavedPostCollection,
} from '../controllers/savedPosts.controller.js'

const router = express.Router()
const savedPostsReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id || 'unauthenticated'),
})
const savedPostsWriteLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id || 'unauthenticated'),
})

router.get('/', requireUser, savedPostsReadLimit, getSavedPosts)
router.get('/status', requireUser, savedPostsReadLimit, getSavedPostStatus)
router.post('/', requireUser, savedPostsWriteLimit, savePost)
router.delete('/source', requireUser, savedPostsWriteLimit, removeSavedPostBySource)

router.get('/collections', requireUser, savedPostsReadLimit, getSavedPostCollections)
router.post('/collections', requireUser, savedPostsWriteLimit, createSavedPostCollection)
router.patch('/collections/:collectionId', requireUser, savedPostsWriteLimit, updateSavedPostCollection)
router.delete('/collections/:collectionId', requireUser, savedPostsWriteLimit, deleteSavedPostCollection)

router.put('/:savedPostId/collections', requireUser, savedPostsWriteLimit, replaceSavedPostCollections)
router.delete('/:savedPostId', requireUser, savedPostsWriteLimit, removeSavedPost)

export default router
