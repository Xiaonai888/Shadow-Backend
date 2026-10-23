import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { wakeStoryEpisodePushScheduler } from '../services/storyEpisodePushScheduler.js'
import {
  createEpisode,
  createStory,
  getEpisodeById,
  getMyStories,
  getStoryById,
  getStoryEpisodes,
  getStoryTrash,
  moveStoryToTrash,
  restoreStoryFromTrash,
  updateEpisode,
  updateStory,
  moveEpisodeToTrash,
} from '../controllers/stories.controller.js'
import {
  getChatStoryCharacterProfile,
  getChatStoryCharacters,
  saveChatStoryCharacters,
  updateChatStoryCharacterProfile,
} from '../controllers/chatStoryCharacters.controller.js'
import { getChatStoryAvatarGallery } from '../controllers/chatStoryAvatarGallery.controller.js'
import {
  saveChatStoryEpisode,
  updateChatStoryEpisodeStatus,
  updateEpisodeStatusByStoryType,
} from '../controllers/chatStoryEpisodes.controller.js'
import { getStoryManagerEpisodes } from '../controllers/storyManager.controller.js'
import { getStoryPerformance } from '../controllers/storyPerformance.controller.js'
import {
  acceptStoryPublishAgreement,
  getStoryPublishAgreement,
} from '../controllers/storyPublishAgreement.controller.js'
import { enforcePaidContentRequirement } from '../middleware/paidContentRequirement.middleware.js'
import { enforceFirstPublishAgreement } from '../middleware/enforceFirstPublishAgreement.middleware.js'
import { requireUser } from '../middleware/user.middleware.js'
import { invalidateMyStoriesCache } from '../services/myStoriesCache.service.js'
import { invalidatePublicStoriesCache } from '../services/publicStoriesResponseCache.service.js'
import { invalidatePublicStoryDataCache } from '../services/publicStoryDataCache.service.js'

const router = express.Router()
const storyRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.user_id || req.user?.id || req.user?.session_id || 'unauthenticated'),
  message: {
    ok: false,
    code: 'STORY_RATE_LIMIT',
    message: 'Too many story requests. Please try again shortly.',
  },
})

function invalidateMyStoriesAfterMutation(req, res, next) {
  const userId = req.user?.user_id
  const storyId = String(
    req.params?.storyId || ''
  ).trim()

  res.once('finish', () => {
    if (
      res.statusCode >= 200 &&
      res.statusCode < 300
    ) {
      if (userId) {
        invalidateMyStoriesCache(userId)
      }

      invalidatePublicStoriesCache()

      if (storyId) {
        invalidatePublicStoryDataCache(
          storyId
        )
      }

      if (
        req.method === 'PATCH' &&
        req.path.endsWith('/status') &&
        req.body?.status === 'published'
      ) {
        wakeStoryEpisodePushScheduler()
      }
    }
  })

  next()
}

router.post('/create', requireUser, storyRateLimit, invalidateMyStoriesAfterMutation, createStory)
router.get('/my', requireUser, storyRateLimit, getMyStories)
router.get('/trash', requireUser, storyRateLimit, getStoryTrash)
router.get('/chat/avatar-gallery', requireUser, storyRateLimit, getChatStoryAvatarGallery)
router.get('/:storyId/chat/characters', requireUser, storyRateLimit, getChatStoryCharacters)
router.put('/:storyId/chat/characters', requireUser, storyRateLimit, saveChatStoryCharacters)
router.get('/:storyId/chat/characters/:characterId/profile', requireUser, storyRateLimit, getChatStoryCharacterProfile)
router.patch('/:storyId/chat/characters/:characterId/profile', requireUser, storyRateLimit, updateChatStoryCharacterProfile)
router.post('/:storyId/chat/episodes/save', requireUser, storyRateLimit, invalidateMyStoriesAfterMutation, saveChatStoryEpisode)
router.patch(
  '/:storyId/chat/episodes/:episodeId/status',
  requireUser,
  storyRateLimit,
  invalidateMyStoriesAfterMutation,
  enforceFirstPublishAgreement,
  enforcePaidContentRequirement,
  updateChatStoryEpisodeStatus
)
router.get('/:storyId/manager-episodes', requireUser, storyRateLimit, getStoryManagerEpisodes)
router.get('/:storyId/performance', requireUser, storyRateLimit, getStoryPerformance)
router.get('/:storyId/publish-agreement', requireUser, storyRateLimit, getStoryPublishAgreement)
router.post('/:storyId/publish-agreement', requireUser, storyRateLimit, acceptStoryPublishAgreement)
router.get('/:storyId', requireUser, storyRateLimit, getStoryById)
router.put('/:storyId', requireUser, storyRateLimit, invalidateMyStoriesAfterMutation, updateStory)
router.delete('/:storyId', requireUser, storyRateLimit, invalidateMyStoriesAfterMutation, moveStoryToTrash)
router.post('/:storyId/restore', requireUser, storyRateLimit, invalidateMyStoriesAfterMutation, restoreStoryFromTrash)

router.post('/:storyId/episodes/create', requireUser, storyRateLimit, invalidateMyStoriesAfterMutation, createEpisode)
router.get('/:storyId/episodes', requireUser, storyRateLimit, getStoryEpisodes)
router.get('/:storyId/episodes/:episodeId', requireUser, storyRateLimit, getEpisodeById)
router.put('/:storyId/episodes/:episodeId', requireUser, storyRateLimit, invalidateMyStoriesAfterMutation, updateEpisode)
router.patch(
  '/:storyId/episodes/:episodeId/status',
  requireUser,
  storyRateLimit,
  invalidateMyStoriesAfterMutation,
  enforceFirstPublishAgreement,
  enforcePaidContentRequirement,
  updateEpisodeStatusByStoryType
)
router.delete('/:storyId/episodes/:episodeId', requireUser, storyRateLimit, invalidateMyStoriesAfterMutation, moveEpisodeToTrash)

export default router
