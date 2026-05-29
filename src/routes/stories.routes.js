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
  updateEpisodeStatus,
  updateStory,
} from '../controllers/stories.controller.js'
import { requireUser } from '../middleware/user.middleware.js'

const router = express.Router()

router.post('/create', requireUser, createStory)
router.get('/my', requireUser, getMyStories)
router.get('/trash', requireUser, getStoryTrash)
router.get('/:storyId', requireUser, getStoryById)
router.put('/:storyId', requireUser, updateStory)
router.delete('/:storyId', requireUser, moveStoryToTrash)
router.post('/:storyId/restore', requireUser, restoreStoryFromTrash)

router.post('/:storyId/episodes/create', requireUser, createEpisode)
router.get('/:storyId/episodes', requireUser, getStoryEpisodes)
router.get('/:storyId/episodes/:episodeId', requireUser, getEpisodeById)
router.put('/:storyId/episodes/:episodeId', requireUser, updateEpisode)
router.patch('/:storyId/episodes/:episodeId/status', requireUser, updateEpisodeStatus)

export default router
