import express from 'express'
import {
  getGiftCatalog,
  getStoryTopFans,
  sendStoryGift,
} from '../controllers/gifts.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

router.get('/catalog', getGiftCatalog)
router.get('/stories/:storyId/top-fans', getStoryTopFans)
router.post('/stories/:storyId/send', requireUser, sendStoryGift)

export default router
