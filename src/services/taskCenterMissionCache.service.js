import { supabase } from '../config/supabase.js'
import { markRequestDiagnostic } from './trafficDiagnostic.service.js'
import { selectTaskCenterSmartAdBatch } from './smartAdDelivery.service.js'
import { getSmartAdReaderHashForUserId, recordTaskCenterSmartAdImpressions } from './smartAdTracking.service.js'
import { smartAdCambodiaSlot } from './smartAdEligibility.service.js'
import smartAutoPolicy from './taskCenter/smartAuto/policy.cjs'
import smartAutoStateStore from './taskCenter/smartAuto/stateStore.cjs'

const { getWindow } = smartAutoPolicy
const { createStateStore } = smartAutoStateStore
const SMART_AUTO_ENABLED = process.env.TASK_CENTER_SMART_AUTO_ENABLED === 'true'
const MODE_TTL_MS = 60 * 1000
const SMART_MODES = new Set(['manual', 'auto', 'smart_auto'])
let modeCache = null
let modePending = null
const smartStateCache = new Map()
const SMART_STATE_CACHE_MAX = 512
const SMART_STATE_TTL_MS = 15 * 1000
const assignmentRequests = new Map()
const impressionRequests = new Map()
const impressionCache = new Map()
const assignmentRetryAt = new Map()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ACTIVE_SESSION_MISSIONS_TTL_MS = 5 * 60 * 1000
const MISSION_LIMIT = 2
const VALID_AUDIENCES = new Set(['khmer', 'international'])
const DAY_MS = 24 * 60 * 60 * 1000
const PHNOM_PENH_OFFSET_MS = 7 * 60 * 60 * 1000

const missionCaches = new Map()
const pendingFetches = new Map()
let cacheGeneration = 0

function checkedAudience(audience) {
  if (!VALID_AUDIENCES.has(audience)) {
    throw new Error('Invalid reading mission audience')
  }
  return audience
}

function missionExpiresAt(now = Date.now()) {
  const localTime = now + PHNOM_PENH_OFFSET_MS
  const untilMidnight = DAY_MS - (localTime % DAY_MS)
  return now + Math.min(ACTIVE_SESSION_MISSIONS_TTL_MS, untilMidnight)
}

function markMissionCache(group, state, error = null) {
  markRequestDiagnostic({
    mission_catalog_audience: group,
    mission_catalog_cache: state,
    mission_catalog_rpc_calls: state === 'miss' ? 1 : 0,
    ...(error ? {
      mission_catalog_error_code: String(error?.code || error?.name || 'UNKNOWN').slice(0, 80),
    } : {}),
  })
}

export function invalidateActiveSessionMissionsCache(audience = null) {
  cacheGeneration += 1
  modeCache = null
  modePending = null
  smartStateCache.clear()
  assignmentRetryAt.clear()
  if (audience === null || audience === undefined) {
    missionCaches.clear()
    pendingFetches.clear()
    return
  }
  const group = checkedAudience(audience)
  missionCaches.delete(group)
  pendingFetches.delete(group)
}

export async function getActiveSessionMissions(audience = 'khmer') {
  const group = checkedAudience(audience)
  const cached = missionCaches.get(group)

  if (cached && Date.now() < cached.expiresAt) {
    markMissionCache(group, 'hit')
    return cached.value
  }

  const generation = cacheGeneration
  const existing = pendingFetches.get(group)
  if (existing?.generation === generation) {
    markMissionCache(group, 'wait')
    return existing.promise
  }

  markMissionCache(group, 'miss')
  const promise = (async () => {
    try {
      const { data, error } = await supabase
        .from('task_center_reading_missions')
        .select('*')
        .eq('audience', group)
        .eq('is_active', true)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: false })
        .limit(MISSION_LIMIT)

      if (error) throw error
      if (generation !== cacheGeneration) {
        return getActiveSessionMissions(group)
      }

      const value = data || []
      missionCaches.set(group, {
        value,
        expiresAt: missionExpiresAt(),
      })
      return value
    } catch (error) {
      markMissionCache(group, 'error', error)
      throw error
    }
  })()

  pendingFetches.set(group, { generation, promise })

  try {
    return await promise
  } finally {
    if (pendingFetches.get(group)?.promise === promise) {
      pendingFetches.delete(group)
    }
  }
}

export async function getTaskCenterMissionMode(audience = 'khmer') {
  const group = checkedAudience(audience)
  if (!SMART_AUTO_ENABLED) return 'legacy'
  if (modeCache && modeCache.expiresAt > Date.now()) return modeCache.value[group]
  if (!modePending) {
    const generation = cacheGeneration
    const request = (async () => {
      const { data, error } = await supabase.from('task_center_settings')
        .select('reading_mission_mode,international_reading_mission_mode')
        .eq('setting_key', 'main').maybeSingle()
      if (error) throw error
      const value = {
        khmer: data?.reading_mission_mode || 'manual',
        international: data?.international_reading_mission_mode || 'manual',
      }
      if (Object.values(value).some(mode => !SMART_MODES.has(mode))) throw new Error('Invalid Task Center mode')
      if (generation !== cacheGeneration) {
        await getTaskCenterMissionMode(group)
        if (modeCache) return modeCache.value
        throw new Error('Task Center settings changed during read')
      }
      modeCache = { value, expiresAt: Date.now() + MODE_TTL_MS }
      return value
    })().finally(() => { if (modePending === request) modePending = null })
    modePending = request
  }
  return (await modePending)[group]
}

function currentDayProgress(row, window) {
  const at = Date.parse(row?.updated_at || '')
  return Number.isFinite(at) && at >= window.dayStart && at < window.dayEnd ? row : null
}

function stateMission(entry, template) {
  if (!entry || !UUID.test(String(entry.storyId || '')) || !UUID.test(String(entry.slotId || ''))) return null
  const settled = entry.status === 'claimable' || entry.status === 'claimed'
  const targetMinutes = Number(settled ? entry.targetMinutes : template.target_minutes)
  const rewardCoins = Number(settled ? entry.rewardCoins : template.reward_coins)
  const window = getWindow(Number(entry.windowStart))
  return {
    id: entry.slotId,
    audience: entry.audience,
    is_active: true,
    title: `Read ${targetMinutes} minutes`,
    subtitle: entry.storyTitle || 'Reading Mission',
    reward_coins: rewardCoins,
    target_minutes: targetMinutes,
    story_link: `/story/${entry.storyId}`,
    button_text: template?.button_text || entry.buttonText || 'Go',
    sort_order: template?.sort_order ?? entry.sortOrder ?? 0,
    smart_auto: true,
    smart_story_id: entry.storyId,
    smart_auto_window_end: window.end,
    smart_auto_day_end: window.dayEnd,
  }
}

function rememberState(userId, value, window) {
  if (smartStateCache.size >= SMART_STATE_CACHE_MAX) smartStateCache.delete(smartStateCache.keys().next().value)
  smartStateCache.set(userId, { value, expiresAt: Math.min(Date.now() + SMART_STATE_TTL_MS, window.dayEnd) })
  return value
}

async function readReaderState(userId, now, cached = false) {
  const window = getWindow(now)
  const item = smartStateCache.get(userId)
  if (cached && item?.expiresAt > now) return item.value
  const { data, error } = await supabase.from('task_center_smart_auto_state')
    .select('revision,day_start_ms,missions,daily_assigned_ids').eq('reader_id', userId).maybeSingle()
  if (error) throw error
  return rememberState(userId, Number(data?.day_start_ms) === window.dayStart ? data : null, window)
}

function publicStateMissions(state, templates, audience) {
  const byId = new Map(templates.map(template => [String(template.id), template]))
  return (state?.missions || [])
    .filter(entry => entry.audience === audience && byId.has(String(entry.slotId)))
    .map(entry => stateMission(entry, byId.get(String(entry.slotId))))
    .filter(Boolean)
    .sort((a, b) => a.sort_order - b.sort_order)
}

async function readEligibleAssignedStories(ids) {
  if (!ids.length) return new Set()
  const { data, error } = await supabase.from('smart_ad_active_pool')
    .select('story_id').in('story_id', ids)
  if (error) throw error
  return new Set((data || []).map(row => String(row.story_id)))
}

async function assignSmartMissions({ userId, audience, storyLanguage, templates, now }) {
  const window = getWindow(now)
  const transaction = createStateStore({ supabase, loadContext: async ({ previous }) => ({ previous }) })
  return transaction(userId, async tx => {
    const { previous, dailyAssignedIds } = await tx.load({ now, window })
    const todayEntries = previous.filter(entry => Number(entry.dayStart ?? getWindow(entry.windowStart).dayStart) === window.dayStart)
    const assigned = new Set(dailyAssignedIds)
    const priorAudience = todayEntries[0]?.audience
    if (priorAudience && priorAudience !== audience) return { missions: [], requiredCount: templates.length, groupChanged: true }
    const templateIds = templates.map(template => String(template.id))
    const oldIds = todayEntries.map(entry => String(entry.storyId))
    const [progressResult, eligible] = await Promise.all([
      templateIds.length ? supabase.from('reader_reading_mission_progress').select('mission_id,story_id,active_seconds,completed_at,claimed_at,updated_at').eq('user_id', userId).in('mission_id', templateIds) : Promise.resolve({ data: [], error: null }),
      readEligibleAssignedStories(oldIds),
    ])
    if (progressResult.error) throw progressResult.error
    const progress = new Map((progressResult.data || []).map(row => [String(row.mission_id), currentDayProgress(row, window)]))
    const bySlot = new Map(todayEntries.map(entry => [String(entry.slotId), entry]))
    const keep = []
    const free = []
    for (const template of templates) {
      const slotId = String(template.id)
      const entry = bySlot.get(slotId)
      const row = progress.get(slotId)
      const hasProgress = Boolean(row && (Number(row.active_seconds || 0) > 0 || row.completed_at || row.claimed_at))
      if (hasProgress && (!entry || (row.story_id && String(row.story_id) !== String(entry.storyId)))) {
        const id = String(row.story_id || '')
        if (!UUID.test(id)) continue
        const storyTitle = String(template.story_link || '').includes(id) ? template.subtitle : 'Reading Mission'
        keep.push({ slotId, storyId: id, storyTitle: storyTitle || 'Reading Mission', audience, language: storyLanguage, dayStart: window.dayStart, windowStart: window.start, rewardCoins: Number(template.reward_coins || 0), targetMinutes: Number(template.target_minutes || 1), sortOrder: Number(template.sort_order || 0), buttonText: template.button_text || 'Go', status: row.claimed_at ? 'claimed' : row.completed_at ? 'claimable' : 'in_progress' })
        assigned.add(id)
        continue
      }
      if (entry && (entry.status === 'claimed' || entry.status === 'claimable' || hasProgress || entry.status === 'in_progress')) {
        if (entry.status === 'claimed' || entry.status === 'claimable' || row?.claimed_at || row?.completed_at || eligible.has(String(entry.storyId))) keep.push(entry)
        continue
      }
      if (entry && entry.windowStart === window.start && entry.language === storyLanguage && eligible.has(String(entry.storyId))) {
        keep.push(entry)
        continue
      }
      free.push(template)
    }
    const limit = Math.min(free.length, Math.max(0, 8 - assigned.size))
    const retryKey = `${userId}:${audience}:${storyLanguage}:${window.start}`
    if (limit > 0 && (assignmentRetryAt.get(retryKey) || 0) <= now) {
      const batch = await selectTaskCenterSmartAdBatch({ readerId: userId, readerHash: getSmartAdReaderHashForUserId(userId), storyLanguage, excludeStoryIds: [...assigned], limit, now })
      if ((batch.ads || []).length < limit) {
        if (assignmentRetryAt.size >= 512) assignmentRetryAt.delete(assignmentRetryAt.keys().next().value)
        assignmentRetryAt.set(retryKey, now + 60000)
      }
      for (const [index, story] of (batch.ads || []).slice(0, limit).entries()) {
        const template = free[index]
        const id = String(story.story_id || '')
        if (!UUID.test(id) || assigned.has(id)) continue
        keep.push({ slotId: String(template.id), storyId: id, storyTitle: story.title || 'Reading Mission', audience, language: storyLanguage, dayStart: window.dayStart, windowStart: window.start, rewardCoins: Number(template.reward_coins || 0), targetMinutes: Number(template.target_minutes || 1), sortOrder: Number(template.sort_order || 0), buttonText: template.button_text || 'Go', status: 'assigned' })
        assigned.add(id)
      }
    }
    keep.sort((a, b) => a.sortOrder - b.sortOrder || a.slotId.localeCompare(b.slotId))
    const dailyIds = [...assigned]
    if (dailyIds.length > 8 || keep.length > 2) throw new Error('Smart Auto mission limit exceeded')
    const changed = JSON.stringify(todayEntries) !== JSON.stringify(keep) || JSON.stringify(dailyAssignedIds) !== JSON.stringify(dailyIds) || previous.length !== todayEntries.length
if (changed) {
  await tx.save({ now, window, missions: keep, dailyAssignedIds: dailyIds })
}
return { missions: keep, daily_assigned_ids: dailyIds, day_start_ms: window.dayStart, requiredCount: templates.length, progressRows: changed ? undefined : (progressResult.data || []) }
  })
}

async function recordDeliveredMissions(userId, state, now) {
  const slot = smartAdCambodiaSlot(now)
  const ids = (state?.missions || []).filter(entry => entry.status === 'assigned' && entry.windowStart === getWindow(now).start).map(entry => entry.storyId)
  if (!ids.length) return
  const key = `${userId}:${slot.slot_key}:${ids.slice().sort().join(',')}`
  if ((impressionCache.get(key) || 0) > now) return
  if (!impressionRequests.has(key)) {
    const pending = (async () => {
      await recordTaskCenterSmartAdImpressions({ readerHash: getSmartAdReaderHashForUserId(userId), slotKey: slot.slot_key, storyIds: ids })
      if (impressionCache.size >= 512) impressionCache.delete(impressionCache.keys().next().value)
      impressionCache.set(key, getWindow(now).end)
    })().finally(() => impressionRequests.delete(key))
    impressionRequests.set(key, pending)
  }
  try { await impressionRequests.get(key) } catch (error) {
    if (impressionCache.size >= 512) impressionCache.delete(impressionCache.keys().next().value)
    impressionCache.set(key, now + 60000)
    console.error('TASK_CENTER_SMART_AUTO_EXPOSURE_ERROR:', String(error?.code || error?.message || 'UNKNOWN').slice(0, 160))
  }
}

export async function getReaderSessionMissionCatalog({ userId, audience, storyLanguage = 'km', allowSelection = false, cached = false } = {}) {
  const mode = await getTaskCenterMissionMode(audience)
  const templates = await getActiveSessionMissions(audience)
  if (mode !== 'smart_auto') return { mode, missions: templates, requiredCount: templates.length }
  if (!UUID.test(String(userId || ''))) throw new Error('Invalid Smart Auto reader')
  const now = Date.now()
  const window = getWindow(now)
  let state
  let progressRows
  if (allowSelection) {
    const key = `${userId}:${audience}:${storyLanguage}:${window.start}`
    if (!assignmentRequests.has(key)) {
      const pending = assignSmartMissions({ userId, audience, storyLanguage, templates, now })
        .finally(() => assignmentRequests.delete(key))
      assignmentRequests.set(key, pending)
    }
    const result = await assignmentRequests.get(key)
const { progressRows: rows, ...stateResult } = result
state = stateResult
progressRows = rows
    if (!state.groupChanged) {
      rememberState(userId, state, window)
    }
  } else {
    state = await readReaderState(userId, now, cached)
  }
  const missions = publicStateMissions(state, templates, audience)
  const visibleSlotIds = new Set(missions.map(mission => String(mission.id)))
  const delivery = allowSelection ? { now, missions: (state?.missions || []).filter(entry => entry.audience === audience && visibleSlotIds.has(String(entry.slotId))) } : null
  return { mode, missions, requiredCount: templates.length, delivery, progressRows }
}

export async function recordReaderSmartAutoDelivery(userId, delivery) {
  if (delivery) await recordDeliveredMissions(userId, delivery, delivery.now)
}

export function invalidateReaderSmartAutoState(userId) {
  smartStateCache.delete(userId)
}
