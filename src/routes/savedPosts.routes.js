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
const savedPostsPreAuthLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 1500,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
})
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

router.get('/', savedPostsPreAuthLimit, requireUser, savedPostsReadLimit, getSavedPosts)
router.get('/status', savedPostsPreAuthLimit, requireUser, savedPostsReadLimit, getSavedPostStatus)
router.post('/', savedPostsPreAuthLimit, requireUser, savedPostsWriteLimit, savePost)
router.delete('/source', savedPostsPreAuthLimit, requireUser, savedPostsWriteLimit, removeSavedPostBySource)

router.get('/collections', savedPostsPreAuthLimit, requireUser, savedPostsReadLimit, getSavedPostCollections)
router.post('/collections', savedPostsPreAuthLimit, requireUser, savedPostsWriteLimit, createSavedPostCollection)
router.patch('/collections/:collectionId', savedPostsPreAuthLimit, requireUser, savedPostsWriteLimit, updateSavedPostCollection)
router.delete('/collections/:collectionId', savedPostsPreAuthLimit, requireUser, savedPostsWriteLimit, deleteSavedPostCollection)

router.put('/:savedPostId/collections', savedPostsPreAuthLimit, requireUser, savedPostsWriteLimit, replaceSavedPostCollections)
router.delete('/:savedPostId', savedPostsPreAuthLimit, requireUser, savedPostsWriteLimit, removeSavedPost)

export default router
