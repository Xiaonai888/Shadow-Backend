import express from 'express'
import {
  getEpisodeUnlockStatus,
  unlockEpisodeWithDiamonds,
} from '../controllers/unlocks.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

router.get('/stories/:storyId/episodes/:episodeId/status', requireUser, getEpisodeUnlockStatus)
router.post('/stories/:storyId/episodes/:episodeId/diamond', requireUser, unlockEpisodeWithDiamonds)

export default router
