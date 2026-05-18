import express from 'express'
import { requireUser } from '../middleware/user.middleware.js'
import {
  addStoryToLibrary,
  addStoryToSubscriptions,
  getReaderLibrary,
  getReaderSubscriptions,
  getStoryCollectionStatus,
  removeStoryFromLibrary,
  removeStoryFromSubscriptions,
} from '../controllers/library.controller.js'

const router = express.Router()

router.get('/library', requireUser, getReaderLibrary)
router.post('/library/:storyId', requireUser, addStoryToLibrary)
router.delete('/library/:storyId', requireUser, removeStoryFromLibrary)

router.get('/subscriptions', requireUser, getReaderSubscriptions)
router.post('/subscriptions/:storyId', requireUser, addStoryToSubscriptions)
router.delete('/subscriptions/:storyId', requireUser, removeStoryFromSubscriptions)

router.get('/status/:storyId', requireUser, getStoryCollectionStatus)

export default router
