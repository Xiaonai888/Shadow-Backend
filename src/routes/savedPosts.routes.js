import express from 'express'
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

router.get('/', requireUser, getSavedPosts)
router.get('/status', requireUser, getSavedPostStatus)
router.post('/', requireUser, savePost)
router.delete('/source', requireUser, removeSavedPostBySource)

router.get('/collections', requireUser, getSavedPostCollections)
router.post('/collections', requireUser, createSavedPostCollection)
router.patch('/collections/:collectionId', requireUser, updateSavedPostCollection)
router.delete('/collections/:collectionId', requireUser, deleteSavedPostCollection)

router.put('/:savedPostId/collections', requireUser, replaceSavedPostCollections)
router.delete('/:savedPostId', requireUser, removeSavedPost)

export default router
