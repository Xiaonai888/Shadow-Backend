import express from 'express'
import {
  getEpisodeUnlockStatus,
  unlockEpisodeWithDiamonds,
  unlockEpisodePackageWithDiamonds,
  unlockEpisodeWithGems,
  unlockEpisodeWithVoucher,
  unlockEpisodeWithStoryCard,
} from '../controllers/unlocks.controller.js'
import { getPlatformUnlockRules } from '../controllers/unlockRules.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

router.get('/rules', getPlatformUnlockRules)
router.get('/stories/:storyId/episodes/:episodeId/status', requireUser, getEpisodeUnlockStatus)
router.post('/stories/:storyId/episodes/:episodeId/diamond', requireUser, unlockEpisodeWithDiamonds)
router.post('/stories/:storyId/episodes/:episodeId/package', requireUser, unlockEpisodePackageWithDiamonds)
router.post('/stories/:storyId/episodes/:episodeId/gem', requireUser, unlockEpisodeWithGems)
router.post('/stories/:storyId/episodes/:episodeId/voucher', requireUser, unlockEpisodeWithVoucher)
router.post('/stories/:storyId/episodes/:episodeId/story-card', requireUser, unlockEpisodeWithStoryCard)


export default router
