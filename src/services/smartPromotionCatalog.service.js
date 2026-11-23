import { supabase } from '../config/supabase.js'
import { normalizeDiscoverPromotionLanguage } from './discoverPromotionLanguageRotation.service.js'

const PAGE_SIZE = 250
const MAX_PAGES = 12
const CACHE_MS = 5 * 60 * 1000
const RULES_CACHE_MS = 30 * 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const cache = new Map()
const inflight = new Map()
let rulesCache = null
let rulesPending = null

function verified(record, language) {
  if (!record || record.promotion_eligible !== true) return null
  const id = String(record.story_id || '').toLowerCase()
  const total = Number(record.total_episodes)
  const locked = Number(record.locked_episode_count)
  const firstId = String(record.first_episode_id || '').toLowerCase()
  if (
    !UUID.test(id) || !UUID.test(firstId) ||
    record.story_language !== language ||
    !String(record.story_title || '').trim() ||
    !String(record.cover_url || '').trim() ||
    !Number.isSafeInteger(total) || total < 10 ||
    !Number.isSafeInteger(locked) || locked < 5 || locked > total
  ) return null
  return {
    story_id: id,
    story_title: String(record.story_title).trim(),
    title: String(record.story_title).trim(),
    description: String(record.description || '').slice(0, 500),
    cover_url: String(record.cover_url).trim(),
    profile_image_url: String(record.cover_url).trim(),
    story_language: language,
    main_genre: String(record.main_genre || '').trim(),
    genre: String(record.main_genre || '').trim(),
    tags: Array.isArray(record.tags) ? record.tags.slice(0, 12) : [],
    story_type: String(record.story_type || 'novel'),
    story_status: String(record.story_status || ''),
    story_kind: /^(short|short_story|short_novel)$/i.test(String(record.story_type)) ? 'short' : 'novel',
    total_views: Math.max(0, Number(record.total_views) || 0),
    created_at: record.created_at || null,
    last_episode_published_at: record.last_episode_published_at || null,
    first_episode_id: firstId,
    total_episodes: total,
    locked_episode_count: locked,
    promotion_eligible: true,
  }
}

async function loadPage({ language, afterId, limit, db }) {
  const { data, error } = await db.rpc('smart_promotion_catalog_v1', {
    p_language: language,
    p_after_id: afterId,
    p_limit: limit,
    p_story_id: null,
  })
  if (error) throw error
  if (!Array.isArray(data)) throw new Error('Invalid Smart Promotion catalog response')
  return data
}

export async function readSmartPromotionCatalog({ language = 'km', force = false, db = supabase, now = Date.now() } = {}) {
  const selectedLanguage = normalizeDiscoverPromotionLanguage(language)
  if (!selectedLanguage) throw new TypeError('Invalid Smart Promotion language')
  const useCache = db === supabase
  const stored = useCache ? cache.get(selectedLanguage) : null
  if (!force && stored?.expiresAt > now) return stored.records
  if (useCache && inflight.has(selectedLanguage)) return inflight.get(selectedLanguage)

  const pending = (async () => {
    const rows = []
    const seen = new Set()
    let afterId = null
    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
      const page = await loadPage({ language: selectedLanguage, afterId, limit: PAGE_SIZE, db })
      if (!page.length) break
      for (const raw of page) {
        const record = verified(raw, selectedLanguage)
        if (!record || seen.has(record.story_id)) continue
        rows.push(record)
        seen.add(record.story_id)
      }
      const nextId = String(page.at(-1)?.story_id || '')
      if (!UUID.test(nextId) || (afterId && nextId <= afterId)) {
        throw new Error('Invalid Smart Promotion catalog cursor')
      }
      afterId = nextId
      if (page.length < PAGE_SIZE) break
    }
    if (useCache) cache.set(selectedLanguage, { records: rows, expiresAt: Date.now() + CACHE_MS })
    return rows
  })()
  if (useCache) inflight.set(selectedLanguage, pending)
  try {
    return await pending
  } finally {
    if (useCache && inflight.get(selectedLanguage) === pending) inflight.delete(selectedLanguage)
  }
}

export async function readSmartPromotionCandidateById(storyId, language, { db = supabase } = {}) {
  const id = String(storyId || '').trim().toLowerCase()
  const selectedLanguage = normalizeDiscoverPromotionLanguage(language)
  if (!UUID.test(id) || !selectedLanguage) return null
  const { data, error } = await db.rpc('smart_promotion_catalog_v1', {
    p_language: selectedLanguage,
    p_after_id: null,
    p_limit: 1,
    p_story_id: id,
  })
  if (error) throw error
  return verified(Array.isArray(data) ? data[0] : null, selectedLanguage)
}

export async function readSmartPromotionDiamondRate({ db = supabase, now = Date.now() } = {}) {
  const useCache = db === supabase
  if (useCache && rulesCache?.expiresAt > now) return rulesCache.rate
  if (useCache && rulesPending) return rulesPending
  const pending = (async () => {
    const { data, error } = await db.from('platform_unlock_rules')
      .select('diamond_per_episode').eq('id', 1).maybeSingle()
    if (error) throw error
    const rate = Number(data?.diamond_per_episode ?? 10)
    if (!Number.isSafeInteger(rate) || rate < 2) throw new Error('Invalid diamond unlock price')
    if (useCache) rulesCache = { rate, expiresAt: Date.now() + RULES_CACHE_MS }
    return rate
  })()
  if (useCache) rulesPending = pending
  try {
    return await pending
  } finally {
    if (useCache && rulesPending === pending) rulesPending = null
  }
}

export function invalidateSmartPromotionCatalog(language = '') {
  if (!language) cache.clear()
  else {
    const normalized = normalizeDiscoverPromotionLanguage(language)
    if (normalized) cache.delete(normalized)
  }
  rulesCache = null
}
