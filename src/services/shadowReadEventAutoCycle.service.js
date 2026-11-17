import { supabase } from '../config/supabase.js'
import { prepareShadowReadEvent } from './shadowReadEventPreparation.service.js'
import { getShadowReadEventAutoCycleWindow } from './shadowReadEventAutoCycleWindow.js'

const CHECK_INTERVAL_MS = 60 * 60 * 1000
let running = false
let started = false
let timer = null
let completedKey = ''

function isEnvironmentEnabled() {
  return process.env.SHADOW_READ_EVENT_AUTO_CYCLE_ENABLED !== 'false'
}

export async function runShadowReadEventAutoCycleOnce(now = new Date()) {
  if (!isEnvironmentEnabled()) return { ok: true, skipped: true, reason: 'environment_disabled' }
  if (running) return { ok: true, skipped: true, reason: 'already_running' }

  const window = getShadowReadEventAutoCycleWindow(now)
  if (!window) return { ok: true, skipped: true, reason: 'outside_automation_window' }

  const key = `${window.startsOn}:${window.shouldEnable ? 'active' : 'prepare'}`
  if (completedKey === key) return { ok: true, skipped: true, reason: 'already_checked' }

  running = true
  try {
    const { data: setting, error: settingError } = await supabase
      .from('shadow_read_event_auto_settings')
      .select('auto_enabled')
      .eq('setting_id', 1)
      .maybeSingle()
    if (settingError) throw settingError
    if (!setting || setting.auto_enabled !== true) {
      return { ok: true, skipped: true, reason: 'admin_automation_disabled' }
    }

    const plan = await prepareShadowReadEvent(window.startsOn)
    if (!plan?.ok || !plan.event_id) throw new Error('Automatic Read Event plan verification failed')

    if (!window.shouldEnable) {
      completedKey = key
      return { ok: true, starts_on: window.startsOn, prepared: true, activated: false }
    }

    const { data, error } = await supabase.rpc('shadow_read_event_auto_activate', {
      p_event_id: plan.event_id,
    })
    if (error) throw error
    const result = Array.isArray(data) ? data[0] : data
    const allowed = new Set(['enabled', 'already_enabled', 'manual_disabled', 'automation_disabled'])
    if (!result || result.ok !== true || typeof result.activated !== 'boolean' ||
        String(result.event_id) !== String(plan.event_id) || !allowed.has(result.reason)) {
      throw new Error('Automatic Read Event activation response is invalid')
    }

    if (result.reason !== 'automation_disabled') completedKey = key
    return {
      ok: true,
      starts_on: window.startsOn,
      prepared: true,
      activated: result.activated,
      reason: result.reason,
    }
  } finally {
    running = false
  }
}

export function startShadowReadEventAutoCycle() {
  if (started || !isEnvironmentEnabled()) return false
  started = true

  async function check() {
    try {
      const result = await runShadowReadEventAutoCycleOnce()
      if (result.activated) {
        console.info('SHADOW_READ_EVENT_AUTO_ENABLED', { starts_on: result.starts_on })
      }
    } catch (error) {
      console.error('SHADOW_READ_EVENT_AUTO_CYCLE_ERROR', {
        code: error?.code || error?.name || 'unknown',
      })
    }
  }

  timer = setInterval(() => { void check() }, CHECK_INTERVAL_MS)
  timer.unref?.()
  void check()
  return true
}

export function stopShadowReadEventAutoCycle() {
  if (!started) return false
  started = false
  if (timer) clearInterval(timer)
  timer = null
  completedKey = ''
  return true
}
