import { supabase } from '../config/supabase.js'
import { readSmartAdActiveCatalogPage, readSmartAdPoolState } from './smartAdPool.service.js'
import { readSmartAdCatalogByIds } from './smartAdCatalog.service.js'
import { scoreSmartAd } from './smartAdSelection.service.js'
import { selectDiverseSmartAdCandidates } from './smartAdDiversityPolicy.service.js'
import { readSmartAdRecentHistory } from './smartAdRecentHistory.service.js'
import { smartAdCambodiaSlot, SMART_AD_POLICY } from './smartAdEligibility.service.js'
import { normalizeStoryLanguage } from './ads/storyLanguageFilter.service.js'
import {
  classifySmartAdReaderProgress,
  readSmartAdReaderProgress,
} from './smartAdReaderProgress.service.js'
import {
  readSmartAdSeenHistory,
  readSmartAdExposureTotals,
  requireSmartAdPlacement,
  SmartAdRequestError,
} from './smartAdTracking.service.js'

const PAGE_SIZE = 50
const MAX_PAGES_PER_SELECTION = 4
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function cursorOffset(value) {
  const input = value === undefined || value === null || value === '' ? '0' : String(value)
  if (!/^\d{1,5}$/.test(input)) throw new SmartAdRequestError('Invalid Smart Ad cursor')
  const offset = Number(input)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > SMART_AD_POLICY.maxCapacity) {
    throw new SmartAdRequestError('Invalid Smart Ad cursor')
  }
  return offset
}

function normalizeInterests(value) {
  if (value === undefined || value === null) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SmartAdRequestError('Invalid Smart Ad interests')
  }
  const entries = Object.entries(value)
  if (entries.length > 24) throw new SmartAdRequestError('Too many Smart Ad interests')
  const clean = {}
  for (const [name, weight] of entries) {
    const key = name.trim().toLowerCase()
    if (!key || key.length > 60 || !Number.isFinite(Number(weight))) {
      throw new SmartAdRequestError('Invalid Smart Ad interest value')
    }
    clean[key] = Math.min(40, Math.max(0, Number(weight)))
  }
  return clean
}

function excludedIds(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 3000) throw new SmartAdRequestError('Invalid excluded stories')
  const ids = [...new Set(value.map((id) => String(id || '').trim().toLowerCase()))]
  if (ids.some((id) => !UUID.test(id))) throw new SmartAdRequestError('Invalid excluded story ID')
  return ids
}

export async function selectSmartAdBatch({
  readerHash, readerId = '', placement, cursor = '0', queueIndex = 0,
  storyLanguage = 'km',
  interests = {}, excludeStoryIds = [], cooldownStoryIds = [], db = supabase, now = Date.now(),
} = {}) {
  requireSmartAdPlacement(placement)
  const language = normalizeStoryLanguage(storyLanguage)
  if (!language) throw new SmartAdRequestError('Invalid Story Language')
  const offset = cursorOffset(cursor)
  const cleanedInterests = normalizeInterests(interests)
  const exclusions = excludedIds(excludeStoryIds)
  const cooldown = excludedIds(cooldownStoryIds)
  if (!Number.isSafeInteger(Number(queueIndex)) || Number(queueIndex) < 0 || Number(queueIndex) > 10000) {
    throw new SmartAdRequestError('Invalid Smart Ad queue index')
  }
  const slot = smartAdCambodiaSlot(now)
  const [state, seenInSlot, recentHistory] = await Promise.all([
    readSmartAdPoolState({ db }),
    readSmartAdSeenHistory(readerHash, slot.slot_key, { db }),
    readSmartAdRecentHistory(readerHash, { db, now }),
  ])
  const hardExcluded = new Set([...seenInSlot, ...exclusions, ...cooldown])
  const candidates = new Map()
  const statuses = new Map()
  const pages = []
  let unseenCount = 0
  let next = String(offset)
  let endOfPool = false
  let progressAvailable = Boolean(readerId)

  for (let i = 0; i < MAX_PAGES_PER_SELECTION; i += 1) {
    const pageStart = next
    const page = await readSmartAdActiveCatalogPage({
      cursor: pageStart, limit: PAGE_SIZE, storyLanguage: language, db, now,
    })
    const eligiblePageStories = (page.stories || []).filter((story) => {
      const id = String(story?.story_id || '').toLowerCase()
      return UUID.test(id) && story.first_episode_id && !hardExcluded.has(id) && !candidates.has(id)
    })
    let progress = new Map()
    if (progressAvailable && eligiblePageStories.length) {
      try {
        progress = await readSmartAdReaderProgress(
          readerId, eligiblePageStories.map((story) => story.story_id), { db },
        )
      } catch (error) {
        progressAvailable = false
        console.error('SMART_AD_READER_PROGRESS_FAILED:', {
          code: String(error?.code || 'UNKNOWN').slice(0, 50),
          message: String(error?.message || 'Read failed').slice(0, 160),
        })
      }
    }

    const unseen = []
    for (const story of eligiblePageStories) {
      const id = String(story.story_id).toLowerCase()
      candidates.set(id, story)
      const status = progressAvailable
        ? classifySmartAdReaderProgress(story, progress.get(id), now)
        : 'unread'
      statuses.set(id, status)
      if (!recentHistory.has(id) && status !== 'cooldown' && status !== 'replay') {
        unseen.push(id)
        unseenCount += 1
      }
    }
    pages.push({ cursor: pageStart, unseen })
    if (!page.next_cursor) {
      next = null
      endOfPool = true
      break
    }
    next = String(page.next_cursor)
    if (unseenCount >= 35) break
  }

  const countLimit = placement === 'opening' || placement === 'me' ? 1 : 10
  const unseenIds = [...candidates.keys()].filter((id) =>
    !recentHistory.has(id) && statuses.get(id) !== 'cooldown' && statuses.get(id) !== 'replay')
  const exposure = await readSmartAdExposureTotals(unseenIds, { db, now })
  const seed = `${readerHash}:${placement}:${slot.slot_key}:${queueIndex}`
  const preferredScore = (story) => scoreSmartAd(story, {
    interests: cleanedInterests, exposure, seed, now,
  })
  const ads = []
  const selected = new Set()
  const groups = progressAvailable
    ? [
      [...candidates.values()].filter((story) => statuses.get(String(story.story_id).toLowerCase()) === 'unread'),
      [...candidates.values()].filter((story) => statuses.get(String(story.story_id).toLowerCase()) === 'in_progress'),
      ...(endOfPool ? [[...candidates.values()].filter((story) =>
        statuses.get(String(story.story_id).toLowerCase()) === 'replay')] : []),
    ]
    : [[...candidates.values()]]

  for (const stories of groups) {
    if (ads.length >= countLimit) break
    const batch = selectDiverseSmartAdCandidates({
      candidates: stories,
      limit: countLimit - ads.length,
      hardExcludedIds: [...hardExcluded, ...selected],
      recentHistory,
      seed,
      now,
      shortShare: SMART_AD_POLICY.shortExposureShare,
      allowRecentFallback: endOfPool,
      preferredScore,
    })
    for (const story of batch) {
      const id = String(story.story_id).toLowerCase()
      if (selected.has(id)) continue
      selected.add(id)
      ads.push(story)
    }
  }

  const unusedPage = pages.find((page) => page.unseen.some((id) => !selected.has(id)))
  const nextCursor = unusedPage ? unusedPage.cursor : next

  return {
    ok: true,
    placement,
    story_language: language,
    slot_key: slot.slot_key,
    slot_started_at: slot.starts_at,
    next_rotation_at: slot.next_rotation_at,
    catalog_version: Number(state.catalog_version || 0),
    ads,
    next_cursor: nextCursor,
    exhausted: endOfPool && nextCursor === null,
    loop_existing_queue: placement === 'freeUnlock',
  }
}

export async function resolveSmartAdEpisodeOne(storyId, { db = supabase, now = Date.now() } = {}) {
  const id = String(storyId || '').trim().toLowerCase()
  if (!UUID.test(id)) throw new SmartAdRequestError('Invalid story ID')
  const { data, error } = await db.from('smart_ad_active_pool')
    .select('story_id').eq('story_id', id).limit(1)
  if (error) throw error
  if (!data?.length) throw new SmartAdRequestError('This story is no longer advertised', 410)
  const [record] = await readSmartAdCatalogByIds([id], { db, now, includeMedia: false })
  if (!record?.first_episode_id) throw new SmartAdRequestError('This story is no longer eligible', 410)
  return {
    story_id: record.story_id,
    first_episode_id: record.first_episode_id,
    reader_path: `/story/${encodeURIComponent(record.story_id)}/episode/${encodeURIComponent(record.first_episode_id)}`,
  }
}
