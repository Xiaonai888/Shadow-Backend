import express from 'express'
import jwt from 'jsonwebtoken'
import { createHash } from 'node:crypto'
import { getLatestPublicEpisodes } from '../controllers/latestEpisodes.controller.js'
import { getActiveDiscoverSpecialPromotion } from '../controllers/discoverSpecialPromotion.controller.js'
import { getActiveDiscoverAuthorStorePromotions } from '../controllers/discoverAuthorStorePromotion.controller.js'
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
import { limitGenreReadBudget } from '../middleware/genreReadBudget.middleware.js'
import {
  cachePublicStoriesResponse,
  invalidatePublicStoriesCache,
} from '../services/publicStoriesResponseCache.service.js'
import { cachePublicStoryRecommendations } from '../services/publicStoryRecommendationsCache.service.js'
import { cachePublicStoryDataResponse } from '../services/publicStoryDataCache.service.js'
import { APP_REGISTRY } from '../config/appRegistry.js'
import { getSupabaseClient } from '../config/supabase.js'

const router = express.Router()
router.get('/discover-special-promotion/active', getActiveDiscoverSpecialPromotion)
router.get('/discover-author-store-promotion/active', getActiveDiscoverAuthorStorePromotions)

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

const episodeReadRequests = new Map()
const EPISODE_READ_INFLIGHT_MAX = 250

function coalesceEpisodeRead(req, res, next) {
  const authorization = String(req.headers.authorization || '')
  const token = authorization.startsWith('Bearer ')
    ? authorization.slice(7)
    : ''
  if (!token || !process.env.JWT_SECRET) return next()

  try {
    const viewer = jwt.verify(token, process.env.JWT_SECRET)
    if (viewer?.type !== 'reader' || !viewer?.user_id) return next()
  } catch {
    return next()
  }

  const key = createHash('sha256')
    .update(`${token}\u001f${req.originalUrl}`)
    .digest('hex')
  const existing = episodeReadRequests.get(key)

  if (existing) {
    existing.promise.then((result) => {
      if (res.headersSent || res.writableEnded || res.destroyed) return
      if (!result) return next()
      res.set('Cache-Control', 'private, no-store')
      return res.status(result.status).json(result.body)
    })
    return
  }

  if (episodeReadRequests.size >= EPISODE_READ_INFLIGHT_MAX) return next()

  let resolvePending
  const entry = {
    promise: new Promise((resolve) => { resolvePending = resolve }),
  }
  episodeReadRequests.set(key, entry)
  const originalJson = res.json.bind(res)
  let completed = false

  const finish = (result) => {
    if (completed) return
    completed = true
    if (episodeReadRequests.get(key) === entry) episodeReadRequests.delete(key)
    resolvePending(result)
  }

  res.json = (body) => {
    finish({ status: res.statusCode || 200, body })
    return originalJson(body)
  }

  res.once('close', () => finish(null))
  next()
}

const episodeViewRequests = new Map()
const EPISODE_VIEW_DEDUPE_MS = 20 * 1000
const EPISODE_VIEW_DEDUPE_MAX = 1500

function coalesceEpisodeView(req, res, next) {
  const authorization = String(req.headers.authorization || '')
  const token = authorization.startsWith('Bearer ')
    ? authorization.slice(7)
    : ''
  if (!token || !process.env.JWT_SECRET) return next()

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    if (decoded?.type !== 'reader' || !decoded?.user_id) return next()
  } catch {
    return next()
  }

  const mode = req.body?.mode === 'qualified' ? 'qualified' : 'fast'
  const key = createHash('sha256')
    .update(`${token}\u001f${req.params.storyId}\u001f${req.params.episodeId}\u001f${mode}`)
    .digest('hex')
  const now = Date.now()
  const existing = episodeViewRequests.get(key)

  if (existing && (existing.pending || existing.expiresAt > now)) {
    if (!existing.pending) return res.status(200).json(existing.body)
    existing.promise.then((body) => {
      if (res.headersSent || res.writableEnded) return
      if (body) res.status(200).json(body)
      else next()
    })
    return
  }

  if (episodeViewRequests.size >= EPISODE_VIEW_DEDUPE_MAX) {
    for (const [entryKey, entry] of episodeViewRequests) {
      if (!entry.pending && entry.expiresAt <= now) episodeViewRequests.delete(entryKey)
    }
    if (episodeViewRequests.size >= EPISODE_VIEW_DEDUPE_MAX) {
      const oldest = [...episodeViewRequests].find(([, entry]) => !entry.pending)
      if (oldest) episodeViewRequests.delete(oldest[0])
    }
  }

  if (episodeViewRequests.size >= EPISODE_VIEW_DEDUPE_MAX) return next()

  let finish
  const entry = {
    pending: true,
    expiresAt: 0,
    body: null,
    promise: new Promise((resolve) => { finish = resolve }),
  }
  episodeViewRequests.set(key, entry)
  const originalJson = res.json.bind(res)

  res.json = (body) => {
    const success = res.statusCode >= 200 && res.statusCode < 300 && body?.ok !== false
    if (episodeViewRequests.get(key) === entry) {
      if (success) {
        entry.pending = false
        entry.body = body
        entry.expiresAt = Date.now() + EPISODE_VIEW_DEDUPE_MS
      } else {
        episodeViewRequests.delete(key)
      }
    }
    finish(success ? body : null)
    return originalJson(body)
  }

  res.once('close', () => {
    if (entry.pending && episodeViewRequests.get(key) === entry) {
      episodeViewRequests.delete(key)
      finish(null)
    }
  })

  next()
}

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
  limitGenreReadBudget,
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

router.get(
  '/stories/:storyId',
  cachePublicStoryDataResponse('detail'),
  getPublicStoryById
)

router.get(
  '/stories/:storyId/episodes',
  personalizeStoryEpisodeList,
  cachePublicStoryDataResponse('episodes'),
  getPublicStoryEpisodes
)

function personalizeStoryEpisodeList(req, res, next) {
  const authorization = String(req.headers.authorization || '')
  const token = authorization.startsWith('Bearer ')
    ? authorization.slice(7)
    : ''
  if (!token || !process.env.JWT_SECRET) return next()

  let viewer
  try {
    viewer = jwt.verify(token, process.env.JWT_SECRET)
  } catch {
    return next()
  }
  if (viewer?.type !== 'reader' || !viewer.user_id) return next()

  res.setHeader('Cache-Control', 'private, no-store')
  const originalJson = res.json.bind(res)
  res.json = async (body) => {
    if (
      res.statusCode !== 200 ||
      body?.ok === false ||
      !Array.isArray(body?.episodes) ||
      !body.episodes.some((episode) => episode.is_locked)
    ) {
      return originalJson(body)
    }

    try {
      const activeUnlocks = new Map()
      const batchSize = 1000
      const now = Date.now()

      for (let offset = 0; ; offset += batchSize) {
        const { data, error } = await getSupabaseClient()
          .from('episode_unlocks')
          .select('episode_id, unlock_type, access_type, expires_at')
          .eq('user_id', viewer.user_id)
          .eq('story_id', req.params.storyId)
          .eq('unlock_status', 'active')
          .order('episode_id', { ascending: true })
          .range(offset, offset + batchSize - 1)

        if (error) throw error

        for (const grant of data || []) {
          const unlockType = String(grant.unlock_type || '').toLowerCase()
          const accessType = String(grant.access_type || '').toLowerCase()
          const permanent = accessType === 'permanent' ||
            ['diamond', 'voucher', 'story_card', 'free_item'].includes(unlockType)
          const expiresAt = grant.expires_at ? Date.parse(grant.expires_at) : null
          const active = grant.expires_at
            ? Number.isFinite(expiresAt) && expiresAt > now
            : permanent

          if (active) activeUnlocks.set(String(grant.episode_id), grant)
        }

        if ((data || []).length < batchSize) break
      }

      return originalJson({
        ...body,
        episodes: body.episodes.map((episode) => {
          const grant = activeUnlocks.get(String(episode.id))
          return {
            ...episode,
            is_locked: Boolean(episode.is_locked && !grant),
            is_unlocked: Boolean(!episode.is_locked || grant),
            unlock_type: grant?.unlock_type || null,
            unlock_expires_at: grant?.expires_at || null,
          }
        }),
      })
    } catch (error) {
      console.error('PERSONALIZE EPISODE UNLOCK LIST ERROR:', error)
      return res.status(503).json({
        ok: false,
        message: 'Failed to check episode unlock access',
      })
    }
  }
  return next()
}

router.get('/stories/:storyId/episodes/:episodeId', coalesceEpisodeRead, getPublicEpisodeById)
router.post(
  '/stories/:storyId/episodes/:episodeId/view',
  coalesceEpisodeView,
  invalidatePublicStoriesAfterCountedView,
  countQualifiedEpisodeView
)
router.get('/latest-episodes', getLatestPublicEpisodes)

export default router
