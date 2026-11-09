import { supabase } from '../config/supabase.js'
import { SMART_AD_POLICY } from './smartAdEligibility.service.js'
import { readSmartAdPoolState, refreshSmartAdPool } from './smartAdPool.service.js'

const STARTUP_DELAY_MS = 15_000
const MAX_CHECK_DELAY_MS = 6 * 60 * 60 * 1000
const MIN_CHECK_DELAY_MS = 60_000
const ERROR_RETRY_DELAY_MS = 15 * 60 * 1000
const PRUNE_BATCH_SIZE = 1_000
const MAX_PRUNE_BATCHES = 5

let started = false
let running = false
let timer = null

function enabled() {
  return String(process.env.SMART_AD_MAINTENANCE_ENABLED || '').toLowerCase() === 'true'
}

function nextDueAt(state, now) {
  const daily = Date.parse(state.last_daily_check_at || '')
  const weekly = Date.parse(state.last_weekly_refresh_at || '')
  const dailyDue = Number.isFinite(daily) ? daily + SMART_AD_POLICY.dailyRefreshMs : now
  const weeklyDue = Number.isFinite(weekly) ? weekly + SMART_AD_POLICY.weeklyRefreshMs : now
  return Math.min(dailyDue, weeklyDue)
}

export async function runSmartAdMaintenanceOnce({ db = supabase, now = Date.now() } = {}) {
  const state = await readSmartAdPoolState({ db })
  const lastDaily = Date.parse(state.last_daily_check_at || '')
  const lastWeekly = Date.parse(state.last_weekly_refresh_at || '')
  const weekly = !Number.isFinite(lastWeekly) || now - lastWeekly >= SMART_AD_POLICY.weeklyRefreshMs
  const daily = !Number.isFinite(lastDaily) || now - lastDaily >= SMART_AD_POLICY.dailyRefreshMs

  if (!weekly && !daily) {
    return { ok: true, refreshed: false, next_due_at: new Date(nextDueAt(state, now)).toISOString() }
  }

  const refresh = await refreshSmartAdPool({ db, now, weekly })
  let prunedRows = 0
  for (let i = 0; i < MAX_PRUNE_BATCHES; i += 1) {
    const { data, error } = await db.rpc('smart_ad_prune_exposure_v1', {
      p_batch_size: PRUNE_BATCH_SIZE,
    })
    if (error) {
      console.warn('SMART_AD_EXPOSURE_PRUNE_ERROR:', error.message)
      break
    }
    const deleted = Math.max(0, Number(data) || 0)
    prunedRows += deleted
    if (deleted < PRUNE_BATCH_SIZE) break
  }
  return {
    ...refresh,
    refreshed: true,
    weekly,
    pruned_rows: prunedRows,
    next_due_at: new Date(now + SMART_AD_POLICY.dailyRefreshMs).toISOString(),
  }
}

function schedule(delayMs) {
  if (!started || !enabled()) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void checkMaintenance()
  }, Math.max(MIN_CHECK_DELAY_MS, Math.min(MAX_CHECK_DELAY_MS, delayMs)))
  timer.unref?.()
}

async function checkMaintenance() {
  if (!started || !enabled() || running) return
  running = true
  try {
    const result = await runSmartAdMaintenanceOnce()
    if (result.refreshed) {
      console.info('SMART_AD_MAINTENANCE:', JSON.stringify({
        active: result.active,
        capacity: result.capacity,
        weekly: result.weekly,
        pruned_rows: result.pruned_rows,
      }))
    }
    const due = Date.parse(result.next_due_at || '')
    schedule(Number.isFinite(due) ? Math.max(MIN_CHECK_DELAY_MS, due - Date.now()) : MAX_CHECK_DELAY_MS)
  } catch (error) {
    console.error('SMART_AD_MAINTENANCE_ERROR:', error)
    schedule(ERROR_RETRY_DELAY_MS)
  } finally {
    running = false
  }
}

export function startSmartAdMaintenanceScheduler() {
  if (started || !enabled()) return false
  started = true
  timer = setTimeout(() => {
    timer = null
    void checkMaintenance()
  }, STARTUP_DELAY_MS)
  timer.unref?.()
  return true
}

export function stopSmartAdMaintenanceScheduler() {
  started = false
  if (timer) clearTimeout(timer)
  timer = null
}
