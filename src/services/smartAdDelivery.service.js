import { supabase } from '../config/supabase.js'
import { readSmartAdActiveCatalogPage, readSmartAdPoolState } from './smartAdPool.service.js'
import { readSmartAdCatalogByIds } from './smartAdCatalog.service.js'
import { chooseSmartAdSelection } from './smartAdSelection.service.js'
import { smartAdCambodiaSlot, SMART_AD_POLICY } from './smartAdEligibility.service.js'
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
  readerHash, placement, cursor = '0', queueIndex = 0,
  interests = {}, excludeStoryIds = [], cooldownStoryIds = [], db = supabase, now = Date.now(),
} = {}) {
  requireSmartAdPlacement(placement)
  const offset = cursorOffset(cursor)
  const cleanedInterests = normalizeInterests(interests)
  const exclusions = new Set(excludedIds(excludeStoryIds))
  const cooldown = excludedIds(cooldownStoryIds)
  if (!Number.isSafeInteger(Number(queueIndex)) || Number(queueIndex) < 0 || Number(queueIndex) > 10000) {
    throw new SmartAdRequestError('Invalid Smart Ad queue index')
  }
  const slot = smartAdCambodiaSlot(now)
  const [state, history] = await Promise.all([
    readSmartAdPoolState({ db }),
    readSmartAdSeenHistory(readerHash, slot.slot_key, { db }),
  ])
  const seen = new Set([...history, ...exclusions, ...cooldown])
  const pages = []
  const candidates = new Map()
  let next = String(offset)
  let endOfPool = false

  for (let i = 0; i < MAX_PAGES_PER_SELECTION; i += 1) {
    const pageStart = next
    const page = await readSmartAdActiveCatalogPage({ cursor: pageStart, limit: PAGE_SIZE, db, now })
    const available = (page.stories || []).filter((story) =>
      story?.story_id && story?.first_episode_id && !seen.has(String(story.story_id)))
    for (const story of available) {
      if (!candidates.has(String(story.story_id))) candidates.set(String(story.story_id), story)
    }
    pages.push({ cursor: pageStart, available })
    if (!page.next_cursor) {
      next = null
      endOfPool = true
      break
    }
    next = page.next_cursor
    if (candidates.size >= 35) break
  }

  const exposure = await readSmartAdExposureTotals([...candidates.keys()], { db, now })
  const ads = chooseSmartAdSelection({
    candidates: [...candidates.values()], readerKey: readerHash, placement,
    slotKey: slot.slot_key, interests: cleanedInterests, exposure,
    seenInSlot: [...seen], cooldownIds: cooldown, queueIndex: Number(queueIndex), now,
  })
  const chosenIds = new Set(ads.map((story) => String(story.story_id)))
  const unusedPage = pages.find((page) => page.available.some((story) => !chosenIds.has(String(story.story_id))))
  const nextCursor = unusedPage ? unusedPage.cursor : next

  return {
    ok: true,
    placement,
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
