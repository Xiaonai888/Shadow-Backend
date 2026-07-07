import express from 'express'
import { getLatestPublicEpisodes } from '../controllers/latestEpisodes.controller.js'
import {
  countQualifiedEpisodeView,
  getPublicEpisodeById,
  getPublicShadowExclusiveStories,
  getPublicShadowExclusiveStoryById,
  getPublicStories,
  getPublicStoryById,
  getPublicStoryEpisodes,
} from '../controllers/publicStories.controller.js'

const router = express.Router()

router.get('/stories', getPublicStories)
router.get('/shadow-exclusive/stories', getPublicShadowExclusiveStories)
router.get('/shadow-exclusive/stories/:storyId', getPublicShadowExclusiveStoryById)

router.get('/stories/:storyId', getPublicStoryById)
router.get('/stories/:storyId/episodes', getPublicStoryEpisodes)
router.get('/stories/:storyId/episodes/:episodeId', getPublicEpisodeById)
router.post('/stories/:storyId/episodes/:episodeId/view', countQualifiedEpisodeView)
router.get('/latest-episodes', getLatestPublicEpisodes)

export default router
