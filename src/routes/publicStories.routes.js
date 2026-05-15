import express from 'express'
import {
  getPublicEpisodeById,
  getPublicStoryById,
  getPublicStoryEpisodes,
} from '../controllers/publicStories.controller.js'

const router = express.Router()

router.get('/stories/:storyId', getPublicStoryById)
router.get('/stories/:storyId/episodes', getPublicStoryEpisodes)
router.get('/stories/:storyId/episodes/:episodeId', getPublicEpisodeById)

export default router
