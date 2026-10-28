import { supabase } from '../config/supabase.js'

const ACTIVE_SESSION_MISSIONS_TTL_MS = 60 * 1000
const MISSION_LIMIT = 2
const VALID_AUDIENCES = new Set(['khmer', 'international'])

const missionCaches = new Map()
const pendingFetches = new Map()
let cacheGeneration = 0

function checkedAudience(audience) {
  if (!VALID_AUDIENCES.has(audience)) {
    throw new Error('Invalid reading mission audience')
  }
  return audience
}

// Existing callers without an audience still receive Khmer missions.
// Omitting audience on invalidation clears both groups.
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

  if (cached && Date.now() < cached.expiresAt) return cached.value

  const generation = cacheGeneration
  const existing = pendingFetches.get(group)
  if (existing?.generation === generation) return existing.promise

  const promise = (async () => {
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
      expiresAt: Date.now() + ACTIVE_SESSION_MISSIONS_TTL_MS,
    })
    return value
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
