import { supabase } from '../config/supabase.js'
import { markRequestDiagnostic } from './trafficDiagnostic.service.js'

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
