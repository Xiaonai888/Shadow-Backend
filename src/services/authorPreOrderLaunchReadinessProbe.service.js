import { supabase } from '../config/supabase.js'
import { preOrderError } from './authorPreOrderValidation.service.js'
import { assessAuthorPreOrderLaunchReadiness } from './authorPreOrderLaunchReadinessPolicy.service.js'

const CACHE_MS = 60_000
let cachedAt = 0
let cachedValue = null
let inFlight = null

async function loadSnapshot() {
  const { data, error } = await supabase.rpc('author_preorder_launch_readiness_snapshot')
  if (error) {
    const code = String(error.code || '')
    console.error('PRE_ORDER_LAUNCH_READINESS_RPC:', code || 'unknown')
    if (['PGRST202', '42883'].includes(code)) {
      throw preOrderError('PRE_ORDER_LAUNCH_MIGRATION_MISSING', 'Launch readiness migration has not been applied', 503)
    }
    throw preOrderError('PRE_ORDER_LAUNCH_READINESS_UNAVAILABLE', 'Could not inspect payment readiness', 503)
  }
  return assessAuthorPreOrderLaunchReadiness(data)
}

export async function probeAuthorPreOrderLaunchReadiness() {
  const now = Date.now()
  if (cachedValue && now - cachedAt < CACHE_MS) {
    return { ...cachedValue, cached: true }
  }
  if (!inFlight) {
    inFlight = loadSnapshot()
      .then(result => {
        cachedValue = result
        cachedAt = Date.now()
        return result
      })
      .finally(() => { inFlight = null })
  }
  const result = await inFlight
  return { ...result, cached: false }
}
