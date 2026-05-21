import express from 'express'
import {
  getEpisodeUnlockStatus,
  unlockEpisodeWithDiamonds,
  unlockEpisodePackageWithDiamonds,
  unlockEpisodeWithGems,
} from '../controllers/unlocks.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

router.get('/stories/:storyId/episodes/:episodeId/status', requireUser, getEpisodeUnlockStatus)
router.post('/stories/:storyId/episodes/:episodeId/diamond', requireUser, unlockEpisodeWithDiamonds)
router.post('/stories/:storyId/episodes/:episodeId/package', requireUser, unlockEpisodePackageWithDiamonds)
router.post('/stories/:storyId/episodes/:episodeId/gem', requireUser, unlockEpisodeWithGems)

export default router
