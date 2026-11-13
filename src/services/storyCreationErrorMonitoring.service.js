import { supabase } from '../config/supabase.js'

const STORY_TYPES = new Set(['novel', 'manga', 'chat_story'])
const STAGES = new Set([
  'CROP', 'LOCAL_DRAFT', 'UPLOAD_QUEUE', 'IMAGE_PROCESS',
  'ONLINE_UPLOAD', 'CREATE_STORY', 'RESTORE_DRAFT', 'UPDATE_STORY',
])
const BROWSERS = new Set(['CHROME', 'SAMSUNG', 'EDGE', 'FIREFOX', 'SAFARI', 'OTHER'])
const SYSTEMS = new Set(['ANDROID', 'IOS', 'WINDOWS', 'MACOS', 'LINUX', 'OTHER'])
const DEVICES = new Set(['MOBILE', 'TABLET', 'DESKTOP'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ERROR_CODE = /^[A-Z0-9_]{2,64}$/
const ERROR_NAME = /^[A-Za-z0-9_-]{1,80}$/
const REPORTS_PER_DAY = 5
const DEDUPE_MS = 30 * 60 * 1000
const CACHE_MS = 5 * 60 * 1000
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000
const RETENTION_MS = 24 * 60 * 60 * 1000
const MAX_TRACKED_USERS = 5000
const activity = new Map()
const userQueues = new Map()
const reportCache = new Map()
let cooldownUntil = 0
let lastPrunedAt = 0
let lastWarningAt = 0

function warnOnce(code) {
  const now = Date.now()
  if (now - lastWarningAt < 5 * 60 * 1000) return
  lastWarningAt = now
  console.warn('STORY_CREATION_ERROR_MONITOR:', String(code || 'unavailable').slice(0, 80))
}

export function validateStoryCreationErrorPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const storyType = String(payload.story_type || '')
  const stage = String(payload.stage || '')
  const errorCode = String(payload.error_code || '')
  const errorName = String(payload.error_name || 'Error')
  const browser = String(payload.browser || '')
  const os = String(payload.os || '')
  const device = String(payload.device || '')
  if (!STORY_TYPES.has(storyType) || !STAGES.has(stage) ||
    !ERROR_CODE.test(errorCode) || !ERROR_NAME.test(errorName) ||
    !BROWSERS.has(browser) || !SYSTEMS.has(os) || !DEVICES.has(device)) return null
  return { storyType, stage, errorCode, errorName, browser, os, device }
}

function userActivity(userId, now) {
  const day = new Date(now).toISOString().slice(0, 10)
  let entry = activity.get(userId)
  if (!entry || entry.day !== day) {
    entry = { day, count: 0, signatures: new Map() }
    activity.set(userId, entry)
  }
  if (activity.size > MAX_TRACKED_USERS) {
    for (const [key, value] of activity) {
      if (value.day !== day) activity.delete(key)
    }
    while (activity.size > MAX_TRACKED_USERS) {
      activity.delete(activity.keys().next().value)
    }
  }
  return entry
}

async function recordVerifiedError(userId, payload) {
  const now = Date.now()
  if (now < cooldownUntil) return { ok: false, status: 503, code: 'STORY_ERROR_MONITOR_UNAVAILABLE' }
  const entry = userActivity(userId, now)
  const signature = [payload.storyType, payload.stage, payload.errorCode, payload.errorName,
    payload.browser, payload.os, payload.device].join(':')
  if (now - (entry.signatures.get(signature) || 0) < DEDUPE_MS) {
    return { ok: true, recorded: false, code: 'DUPLICATE' }
  }
  if (entry.count >= REPORTS_PER_DAY) {
    return { ok: true, recorded: false, code: 'DAILY_LIMIT' }
  }
  try {
    const { data, error } = await supabase.rpc('record_story_creation_error', {
      p_user_id: userId,
      p_story_type: payload.storyType,
      p_stage: payload.stage,
      p_error_code: payload.errorCode,
      p_error_name: payload.errorName,
      p_browser: payload.browser,
      p_os: payload.os,
      p_device: payload.device,
    })
    if (error || data !== true) throw error || new Error('STORY_MONITOR_REJECTED')
    entry.signatures.set(signature, Date.now())
    entry.count += 1
    for (const [key, time] of entry.signatures) {
      if (now - time > DEDUPE_MS) entry.signatures.delete(key)
    }
    reportCache.clear()
    if (now - lastPrunedAt >= RETENTION_MS) {
      lastPrunedAt = now
      void supabase.rpc('prune_story_creation_error_events').then(({ error: pruneError }) => {
        if (pruneError) warnOnce(pruneError.code || 'PRUNE_FAILED')
      }).catch(() => warnOnce('PRUNE_FAILED'))
    }
    return { ok: true, recorded: true, code: 'RECORDED' }
  } catch (error) {
    cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
    warnOnce(error?.code || 'WRITE_FAILED')
    return { ok: false, status: 503, code: 'STORY_ERROR_MONITOR_UNAVAILABLE' }
  }
}

export async function recordStoryCreationError(userId, payload) {
  if (!UUID.test(String(userId || ''))) {
    return { ok: false, status: 401, code: 'STORY_ERROR_ACCOUNT_INVALID' }
  }
  const valid = validateStoryCreationErrorPayload(payload)
  if (!valid) return { ok: false, status: 400, code: 'STORY_ERROR_INVALID_PAYLOAD' }
  const pending = userQueues.get(userId) || Promise.resolve()
  const task = pending.catch(() => {}).then(() => recordVerifiedError(userId, valid))
  userQueues.set(userId, task)
  try {
    return await task
  } finally {
    if (userQueues.get(userId) === task) userQueues.delete(userId)
  }
}

export async function getStoryCreationErrorDiagnostics(hours = 24, force = false) {
  const selected = [1, 6, 24, 168].includes(Number(hours)) ? Number(hours) : 24
  const now = Date.now()
  const cached = reportCache.get(selected)
  if (!force && cached && cached.expiresAt > now) return cached.value
  if (cached?.pending) return cached.pending
  const pending = (async () => {
    const { data, error } = await supabase.rpc('get_story_creation_error_diagnostics', {
      p_hours: selected,
    })
    if (error || !data || typeof data !== 'object') {
      warnOnce(error?.code || 'REPORT_FAILED')
      return { available: false, hours: selected, status: 'REPORT_UNAVAILABLE' }
    }
    return data
  })()
  reportCache.set(selected, { pending })
  try {
    const value = await pending
    reportCache.set(selected, { value, expiresAt: Date.now() + (value.available ? CACHE_MS : 60000) })
    return value
  } catch (error) {
    warnOnce(error?.code || 'REPORT_FAILED')
    reportCache.delete(selected)
    return { available: false, hours: selected, status: 'REPORT_UNAVAILABLE' }
  }
}
