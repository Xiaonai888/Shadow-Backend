import { supabase } from '../config/supabase.js'
import { readSmartAdCandidatePage, readSmartAdCatalogByIds } from './smartAdCatalog.service.js'
import { SMART_AD_POLICY, clampSmartAdCapacity } from './smartAdEligibility.service.js'

const PAGE = 100
const MAX_SCAN = 12000
const CATALOG_TTL_MS = 2 * 60000
const catalogPageCache = new Map()
const inFlightPages = new Map()
let refreshPromise = null
let localEpoch = 0
let stateCache = new WeakMap()
let stateInflight = new WeakMap()
const STATE_TTL_MS = 3000

function verify(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  return result.data || []
}

function scoreCandidate(record, existing = false) {
  const views = Math.max(0, Number(record.total_views) || 0)
  const freshness = record.fresh_30_days ? 30 : 0
  // Existing eligible members have a small retention bonus. Low-view stories
  // still outrank high-view stories; metadata edits cannot fake freshness.
  return 100 / (1 + Math.log1p(views)) + freshness + (existing ? 4 : 0)
}

async function readPoolEntries(db) {
  const rows = []
  for (let start = 0; start < SMART_AD_POLICY.maxCapacity; start += PAGE) {
    const chunk = verify(await db.from('smart_ad_active_pool')
      .select('story_id,priority_score,story_kind').order('priority_score', { ascending: false })
      .order('story_id', { ascending: true }).range(start, start + PAGE - 1), 'Smart Ad pool read')
    rows.push(...chunk)
    if (chunk.length < PAGE) break
  }
  return rows
}

export async function readSmartAdPoolState({ db = supabase } = {}) {
  const cached = stateCache.get(db)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  if (stateInflight.has(db)) return stateInflight.get(db)
  const request = (async () => {
    const state = verify(await db.from('smart_ad_engine_state')
      .select('id,capacity,catalog_version,last_daily_check_at,last_weekly_refresh_at')
      .eq('id', 1).limit(1), 'Smart Ad state read')[0]
    if (!state) throw new Error('Smart Ad SQL setup is not installed')
    stateCache.set(db, { value: state, expiresAt: Date.now() + STATE_TTL_MS })
    return state
  })().finally(() => stateInflight.delete(db))
  stateInflight.set(db, request)
  return request
}

export function invalidateSmartAdLocalCatalog() {
  localEpoch += 1
  catalogPageCache.clear()
  inFlightPages.clear()
  stateCache = new WeakMap()
  stateInflight = new WeakMap()
}

export async function refreshSmartAdPool({
  db = supabase, now = Date.now(), weekly = false, scanLimit = MAX_SCAN,
} = {}) {
  // Must be called by a scheduled/admin maintenance task, NEVER on every GET.
  if (refreshPromise) return refreshPromise
  const execute = async () => {
    const state = await readSmartAdPoolState({ db })
    const existing = await readPoolEntries(db)
    const activeIds = existing.map((row) => String(row.story_id))
    const recordsById = new Map()
    for (let index = 0; index < activeIds.length; index += PAGE) {
      const records = await readSmartAdCatalogByIds(activeIds.slice(index, index + PAGE), { db, now, includeMedia: false })
      for (const record of records) recordsById.set(record.story_id, record)
    }
    const verifiedOld = new Set(recordsById.keys())
    const boundedScan = Math.max(PAGE, Math.min(MAX_SCAN, Math.floor(Number(scanLimit) || MAX_SCAN)))
    for (let offset = 0; offset < boundedScan; offset += PAGE) {
      const page = await readSmartAdCandidatePage({ offset, limit: PAGE, db, now })
      for (const record of page.records) {
        if (!recordsById.has(record.story_id)) recordsById.set(record.story_id, record)
      }
      if (page.next_offset === null) break
    }
    const choices = [...recordsById.values()]
    choices.sort((a, b) => scoreCandidate(b, verifiedOld.has(b.story_id))
      - scoreCandidate(a, verifiedOld.has(a.story_id)) || a.story_id.localeCompare(b.story_id))
    const oldCapacity = clampSmartAdCapacity(state.capacity)
    const capacity = choices.length > oldCapacity && oldCapacity < SMART_AD_POLICY.maxCapacity
      ? clampSmartAdCapacity(Math.min(choices.length, oldCapacity + SMART_AD_POLICY.expansionStep))
      : oldCapacity
    const selected = weekly
      ? choices.slice(0, capacity)
      : [
        ...choices.filter((item) => verifiedOld.has(item.story_id)).slice(0, capacity),
        ...choices.filter((item) => !verifiedOld.has(item.story_id)),
      ].slice(0, capacity)
    const payload = selected.map((record) => ({
      story_id: record.story_id,
      story_kind: record.story_kind,
      priority_score: scoreCandidate(record, verifiedOld.has(record.story_id)),
    }))
    // Atomic SQL reconciliation; no per-story writes or client-side pool tables.
    const result = await db.rpc('smart_ad_pool_reconcile_v1', {
      p_records: payload, p_capacity: capacity, p_weekly: Boolean(weekly),
    })
    verify(result, 'Smart Ad pool reconciliation')
    invalidateSmartAdLocalCatalog()
    return { ok: true, scanned: recordsById.size, active: selected.length, capacity,
      next_weekly_due_at: new Date(now + SMART_AD_POLICY.weeklyRefreshMs).toISOString() }
  }
  const promise = execute().finally(() => { if (refreshPromise === promise) refreshPromise = null })
  refreshPromise = promise
  return promise
}

export async function readSmartAdActiveCatalogPage({
  cursor = 0, limit = 50, db = supabase, now = Date.now(),
} = {}) {
  const offset = Math.max(0, Math.floor(Number(cursor) || 0))
  const take = Math.max(1, Math.min(PAGE, Math.floor(Number(limit) || 50)))
  const state = await readSmartAdPoolState({ db })
  const key = `${localEpoch}:${state.catalog_version}:${offset}:${take}`
  const cached = catalogPageCache.get(key)
  if (cached && cached.expiresAt > now) return cached.value
  if (inFlightPages.has(key)) return inFlightPages.get(key)
  const promise = (async () => {
    const rows = verify(await db.from('smart_ad_active_pool').select('story_id')
      .order('priority_score', { ascending: false }).order('story_id', { ascending: true })
      .range(offset, offset + take - 1), 'Smart Ad catalog IDs')
    const stories = await readSmartAdCatalogByIds(rows.map((row) => row.story_id), { db, now })
    const result = {
      ok: true, stories: stories.map((story) => ({
        ...story, eligibility_version: Number(state.catalog_version),
      })), catalog_version: state.catalog_version,
      next_cursor: rows.length === take ? String(offset + take) : null,
    }
    if (catalogPageCache.size >= 24) catalogPageCache.delete(catalogPageCache.keys().next().value)
    catalogPageCache.set(key, { value: result, expiresAt: Date.now() + CATALOG_TTL_MS })
    return result
  })().finally(() => inFlightPages.delete(key))
  inFlightPages.set(key, promise)
  return promise
}

export async function removeSmartAdStories(storyIds, { db = supabase } = {}) {
  const ids = [...new Set((Array.isArray(storyIds) ? storyIds : []).filter(Boolean).map(String))]
  if (!ids.length || ids.length > PAGE) throw new RangeError('Supply 1–100 story IDs')
  const result = await db.rpc('smart_ad_pool_remove_v1', { p_story_ids: ids })
  verify(result, 'Smart Ad immediate removal')
  invalidateSmartAdLocalCatalog()
  return { ok: true, removed_ids: ids }
}
