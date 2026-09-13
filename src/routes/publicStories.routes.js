import express from 'express'
import { getLatestPublicEpisodes } from '../controllers/latestEpisodes.controller.js'
import {
  getPublicStoryRecommendations,
  countQualifiedEpisodeView,
  getPublicEpisodeById,
  getPublicShadowExclusiveStories,
  getPublicShadowExclusiveStoryById,
  getPublicStories,
  getPublicStoryById,
  getPublicStoryEpisodes,
} from '../controllers/publicStories.controller.js'
import { getPublicWeeklyUpdates } from '../controllers/weeklyUpdates.controller.js'
import { getPublicStoryUpdates } from '../controllers/storyUpdates.controller.js'
import {
  cachePublicStoriesResponse,
  invalidatePublicStoriesCache,
} from '../services/publicStoriesResponseCache.service.js'

const router = express.Router()

function invalidatePublicStoriesAfterCountedView(req, res, next) {
  const originalJson = res.json.bind(res)

  res.json = (body) => {
    if (
      res.statusCode >= 200 &&
      res.statusCode < 300 &&
      body?.ok !== false &&
      body?.view?.counted === true
    ) {
      invalidatePublicStoriesCache()
    }

    return originalJson(body)
  }

  next()
}

router.get('/stories', cachePublicStoriesResponse, getPublicStories)
router.get('/weekly-updates', getPublicWeeklyUpdates)
router.get('/story-updates', getPublicStoryUpdates)
router.get('/shadow-exclusive/stories', getPublicShadowExclusiveStories)
router.get('/shadow-exclusive/stories/:storyId', getPublicShadowExclusiveStoryById)

router.get(
  '/stories/:storyId/recommendations',
  getPublicStoryRecommendations
)

router.get('/stories/:storyId', getPublicStoryById)
router.get('/stories/:storyId/episodes', getPublicStoryEpisodes)
router.get('/stories/:storyId/episodes/:episodeId', getPublicEpisodeById)
router.post(
  '/stories/:storyId/episodes/:episodeId/view',
  invalidatePublicStoriesAfterCountedView,
  countQualifiedEpisodeView
)
router.get('/latest-episodes', getLatestPublicEpisodes)

export default router
