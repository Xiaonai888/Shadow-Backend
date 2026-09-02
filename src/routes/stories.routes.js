import express from 'express'
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
import { requireUser } from '../middleware/user.middleware.js'
import { invalidateMyStoriesCache } from '../services/myStoriesCache.service.js'

const router = express.Router()

function invalidateMyStoriesAfterMutation(req, res, next) {
  const userId = req.user?.user_id

  res.once('finish', () => {
    if (
      userId &&
      res.statusCode >= 200 &&
      res.statusCode < 300
    ) {
      invalidateMyStoriesCache(userId)
    }
  })

  next()
}

router.post('/create', requireUser, invalidateMyStoriesAfterMutation, createStory)
router.get('/my', requireUser, getMyStories)
router.get('/trash', requireUser, getStoryTrash)
router.get('/chat/avatar-gallery', requireUser, getChatStoryAvatarGallery)
router.get('/:storyId/chat/characters', requireUser, getChatStoryCharacters)
router.put('/:storyId/chat/characters', requireUser, saveChatStoryCharacters)
router.get('/:storyId/chat/characters/:characterId/profile', requireUser, getChatStoryCharacterProfile)
router.patch('/:storyId/chat/characters/:characterId/profile', requireUser, updateChatStoryCharacterProfile)
router.post('/:storyId/chat/episodes/save', requireUser, invalidateMyStoriesAfterMutation, saveChatStoryEpisode)
router.patch(
  '/:storyId/chat/episodes/:episodeId/status',
  requireUser,
  invalidateMyStoriesAfterMutation,
  enforcePaidContentRequirement,
  updateChatStoryEpisodeStatus
)
router.get('/:storyId/manager-episodes', requireUser, getStoryManagerEpisodes)
router.get('/:storyId/performance', requireUser, getStoryPerformance)
router.get('/:storyId/publish-agreement', requireUser, getStoryPublishAgreement)
router.post('/:storyId/publish-agreement', requireUser, acceptStoryPublishAgreement)
router.get('/:storyId', requireUser, getStoryById)
router.put('/:storyId', requireUser, invalidateMyStoriesAfterMutation, updateStory)
router.delete('/:storyId', requireUser, invalidateMyStoriesAfterMutation, moveStoryToTrash)
router.post('/:storyId/restore', requireUser, invalidateMyStoriesAfterMutation, restoreStoryFromTrash)

router.post('/:storyId/episodes/create', requireUser, invalidateMyStoriesAfterMutation, createEpisode)
router.get('/:storyId/episodes', requireUser, getStoryEpisodes)
router.get('/:storyId/episodes/:episodeId', requireUser, getEpisodeById)
router.put('/:storyId/episodes/:episodeId', requireUser, invalidateMyStoriesAfterMutation, updateEpisode)
router.patch(
  '/:storyId/episodes/:episodeId/status',
  requireUser,
  invalidateMyStoriesAfterMutation,
  enforcePaidContentRequirement,
  updateEpisodeStatusByStoryType
)
router.delete('/:storyId/episodes/:episodeId', requireUser, invalidateMyStoriesAfterMutation, moveEpisodeToTrash)

export default router
