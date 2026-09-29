import { supabase } from '../config/supabase.js'

const ACTIVE_SESSION_MISSIONS_TTL_MS = 60 * 1000

let activeSessionMissionsCache = null
let activeSessionMissionsPending = null
let activeSessionMissionsGeneration = 0

export function invalidateActiveSessionMissionsCache() {
  activeSessionMissionsGeneration += 1
  activeSessionMissionsCache = null
  activeSessionMissionsPending = null
}

export async function getActiveSessionMissions() {
  if (activeSessionMissionsCache && Date.now() < activeSessionMissionsCache.expiresAt) {
    return activeSessionMissionsCache.value
  }

  const generation = activeSessionMissionsGeneration

  if (activeSessionMissionsPending?.generation === generation) {
    return activeSessionMissionsPending.promise
  }

  const promise = (async () => {
    const { data, error } = await supabase
      .from('task_center_reading_missions')
      .select('*')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false })
      .limit(20)

    if (error) throw error

    if (generation !== activeSessionMissionsGeneration) {
      return getActiveSessionMissions()
    }

    const value = data || []

    activeSessionMissionsCache = {
      value,
      expiresAt: Date.now() + ACTIVE_SESSION_MISSIONS_TTL_MS,
    }

    return value
  })()

  activeSessionMissionsPending = { generation, promise }

  try {
    return await promise
  } finally {
    if (activeSessionMissionsPending?.promise === promise) {
      activeSessionMissionsPending = null
    }
  }
}
