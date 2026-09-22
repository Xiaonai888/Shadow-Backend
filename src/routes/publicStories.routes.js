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
import { createSpamGuard } from '../middleware/spamGuard.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import {
  cachePublicStoriesResponse,
  invalidatePublicStoriesCache,
} from '../services/publicStoriesResponseCache.service.js'
import { cachePublicStoryRecommendations } from '../services/publicStoryRecommendationsCache.service.js'
import { APP_REGISTRY } from '../config/appRegistry.js'
import { getSupabaseClient } from '../config/supabase.js'

const router = express.Router()

const publicStoriesListCacheHitLimit = createRateLimit({
  key: 'public-stories-list-cache-hit',
  windowMs: 60 * 1000,
  max: 1500,
  message: 'Too many requests. Please wait before trying again.',
})

const publicStoriesListReadSpamGuard = createSpamGuard({
  scope: 'reader_read',
  threshold: 300,
  windowSeconds: 60,
})

function invalidatePublicStoriesAfterCountedView(req, res, next) {
  const originalJson = res.json.bind(res)

  res.json = (body) => {
    if (
      res.statusCode >= 200 &&
      res.statusCode < 300 &&
      body?.ok !== false &&
      body?.view?.counted === true
    ) {
      invalidatePublicStoriesCache({ viewSensitiveOnly: true })
    }

    return originalJson(body)
  }

  next()
}

router.get('/apps', async (req, res) => {
  try {
    const client = getSupabaseClient()
    if (!client) {
      return res.status(503).json({ ok: false, message: 'App settings unavailable' })
    }

    const { data, error } = await client
      .from('app_settings')
      .select('app_key,name,profile_url,hidden,disabled')
      .in('app_key', APP_REGISTRY.map(({ appKey }) => appKey))

    if (error) throw error

    const stored = new Map((data || []).map((item) => [item.app_key, item]))
    const apps = APP_REGISTRY.map((definition) => {
      const row = stored.get(definition.appKey)
      return {
        appKey: definition.appKey,
        name: row?.name || definition.name,
        profile: row?.profile_url || definition.profile || null,
        hidden: row?.hidden ?? definition.hidden,
        disabled: row?.disabled ?? definition.disabled,
      }
    })

    res.set('Cache-Control', 'public, max-age=30, must-revalidate')
    return res.json({ ok: true, apps })
  } catch (error) {
    console.error('PUBLIC APPS ERROR:', error)
    return res.status(503).json({ ok: false, message: 'App settings unavailable' })
  }
})

router.get(
  '/stories',
  publicStoriesListCacheHitLimit,
  cachePublicStoriesResponse,
  publicStoriesListReadSpamGuard,
  getPublicStories
)
router.get('/weekly-updates', getPublicWeeklyUpdates)
router.get('/story-updates', getPublicStoryUpdates)
router.get('/shadow-exclusive/stories', getPublicShadowExclusiveStories)
router.get('/shadow-exclusive/stories/:storyId', getPublicShadowExclusiveStoryById)

router.get(
  '/stories/:storyId/recommendations',
  cachePublicStoryRecommendations,
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
