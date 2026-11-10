import { supabase } from '../config/supabase.js'
import { readSmartAdPoolState, refreshSmartAdPool, invalidateSmartAdLocalCatalog } from './smartAdPool.service.js'

const BOOTSTRAP_LIMIT = 1000
const SCAN_LIMIT = 12000
let pendingOperation = null

export class SmartAdAdminBusyError extends Error {
  constructor() {
    super('A Smart Ad pool operation is already running')
    this.name = 'SmartAdAdminBusyError'
    this.status = 409
  }
}

function ensure(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  return result
}

async function withExclusiveOperation(operation) {
  if (pendingOperation) throw new SmartAdAdminBusyError()
  const promise = Promise.resolve().then(operation)
  pendingOperation = promise
  try {
    return await promise
  } finally {
    if (pendingOperation === promise) pendingOperation = null
  }
}

export async function getSmartAdAdminStatus({ db = supabase } = {}) {
  const [state, poolCount] = await Promise.all([
    readSmartAdPoolState({ db }),
    db.from('smart_ad_active_pool')
      .select('story_id', { count: 'exact', head: true }),
  ])
  ensure(poolCount, 'Smart Ad active pool count')
  const active = Math.max(0, Number(poolCount.count || 0))
  return {
    ok: true,
    capacity: Number(state.capacity || BOOTSTRAP_LIMIT),
    catalog_version: Number(state.catalog_version || 0),
    active_stories: active,
    has_active_stories: active > 0,
    maintenance_enabled: process.env.SMART_AD_MAINTENANCE_ENABLED === 'true',
    last_daily_check_at: state.last_daily_check_at || null,
    last_weekly_refresh_at: state.last_weekly_refresh_at || null,
    operation_in_progress: Boolean(pendingOperation),
  }
}

export async function bootstrapSmartAdPool({ db = supabase } = {}) {
  return withExclusiveOperation(async () => {
    const { data, error } = await db.rpc('smart_ad_bootstrap_pool_v2', {
      p_target: BOOTSTRAP_LIMIT,
      p_scan_limit: SCAN_LIMIT,
    })
    ensure({ data, error }, 'Smart Ad bootstrap RPC')
    const row = Array.isArray(data) ? data[0] : data
    if (!row || !Number.isSafeInteger(Number(row.active_count))) {
      throw new Error('Smart Ad bootstrap did not return a valid count')
    }
    invalidateSmartAdLocalCatalog()
    return {
      ok: true,
      inserted_count: Math.max(0, Number(row.inserted_count || 0)),
      active_count: Math.max(0, Number(row.active_count || 0)),
      catalog_version: Number(row.catalog_version || 0),
    }
  })
}

export async function refreshSmartAdPoolNow({ db = supabase } = {}) {
  return withExclusiveOperation(async () => {
    const result = await refreshSmartAdPool({
      db,
      now: Date.now(),
      weekly: false,
      scanLimit: SCAN_LIMIT,
    })
    return {
      ok: true,
      active_count: Number(result.active || 0),
      capacity: Number(result.capacity || BOOTSTRAP_LIMIT),
      scanned: Number(result.scanned || 0),
    }
  })
}
