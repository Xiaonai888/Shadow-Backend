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
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

router.post('/create', requireUser, createStory)
router.get('/my', requireUser, getMyStories)
router.get('/trash', requireUser, getStoryTrash)
router.get('/chat/avatar-gallery', requireUser, getChatStoryAvatarGallery)
router.get('/:storyId/chat/characters', requireUser, getChatStoryCharacters)
router.put('/:storyId/chat/characters', requireUser, saveChatStoryCharacters)
router.get('/:storyId/chat/characters/:characterId/profile', requireUser, getChatStoryCharacterProfile)
router.patch('/:storyId/chat/characters/:characterId/profile', requireUser, updateChatStoryCharacterProfile)
router.post('/:storyId/chat/episodes/save', requireUser, saveChatStoryEpisode)
router.patch('/:storyId/chat/episodes/:episodeId/status', requireUser, updateChatStoryEpisodeStatus)
router.get('/:storyId', requireUser, getStoryById)
router.put('/:storyId', requireUser, updateStory)
router.delete('/:storyId', requireUser, moveStoryToTrash)
router.post('/:storyId/restore', requireUser, restoreStoryFromTrash)

router.post('/:storyId/episodes/create', requireUser, createEpisode)
router.get('/:storyId/episodes', requireUser, getStoryEpisodes)
router.get('/:storyId/episodes/:episodeId', requireUser, getEpisodeById)
router.put('/:storyId/episodes/:episodeId', requireUser, updateEpisode)
router.patch('/:storyId/episodes/:episodeId/status', requireUser, updateEpisodeStatusByStoryType)
router.delete('/:storyId/episodes/:episodeId', requireUser, moveEpisodeToTrash)

export default router
