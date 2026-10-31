import { supabase } from '../config/supabase.js'

const DAY_MS = 86400000
const FIRST_EVENT_MS = Date.UTC(2026, 10, 2)
const CYCLE_DAYS = 28
const EVENT_DAYS = 7
const CAMBODIA_OFFSET_MS = 7 * 60 * 60 * 1000
const POLL_MS = 15 * 60 * 1000

let started = false
let running = false
let timer = null

function isEnabled() {
  return process.env.SHADOW_READ_EVENT_SETTLEMENT_ENABLED !== 'false'
}

export function getShadowReadEventSettlementWindow(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return null

  const today = new Date(now.getTime() + CAMBODIA_OFFSET_MS)
    .toISOString().slice(0, 10)
  const todayUtc = Date.parse(`${today}T00:00:00.000Z`)
  const elapsedDays = (todayUtc - FIRST_EVENT_MS) / DAY_MS
  if (!Number.isInteger(elapsedDays) || elapsedDays < 1) return null

  const cycleDay = elapsedDays % CYCLE_DAYS
  if (cycleDay === 0) return null

  const startsOn = new Date(todayUtc - cycleDay * DAY_MS)
    .toISOString().slice(0, 10)

  return {
    startsOn,
    lastClosedDay: Math.min(cycleDay, EVENT_DAYS),
  }
}

export async function settleShadowReadEventDailyTop3Once() {
  if (!isEnabled()) return { skipped: true, reason: 'worker_disabled' }
  if (running) return { skipped: true, reason: 'already_running' }

  const window = getShadowReadEventSettlementWindow()
  if (!window) return { skipped: true, reason: 'no_closed_event_day' }

  running = true
  try {
    const { data: event, error: eventError } = await supabase
      .from('shadow_read_event_weeks')
      .select('id')
      .eq('starts_on', window.startsOn)
      .eq('audience_group', 'kh')
      .eq('is_enabled', true)
      .maybeSingle()

    if (eventError) throw eventError
    if (!event) return { skipped: true, reason: 'event_not_enabled' }

    const { data: existing, error: existingError } = await supabase
      .from('shadow_read_event_daily_settlements')
      .select('day_number')
      .eq('event_id', event.id)
      .lte('day_number', window.lastClosedDay)
      .limit(EVENT_DAYS)

    if (existingError) throw existingError
    const settledDays = new Set((existing || []).map((row) => Number(row.day_number)))
    let settled = 0
    let awarded = 0

    for (let day = 1; day <= window.lastClosedDay; day += 1) {
      if (settledDays.has(day)) continue

      const { data, error } = await supabase.rpc('shadow_read_event_settle_daily_top3', {
        p_event_id: event.id,
        p_day_number: day,
      })
      if (error) throw error

      const result = Array.isArray(data) ? data[0] : data
      const awardedCount = Number(result?.awarded_count)
      if (!result || result.ok !== true || result.settled !== true ||
          String(result.event_id) !== String(event.id) ||
          Number(result.day_number) !== day ||
          !Number.isInteger(awardedCount) || awardedCount < 0 || awardedCount > 3 ||
          !Array.isArray(result.winners) || result.winners.length !== awardedCount) {
        throw new Error('Invalid Read Event Daily Top 3 settlement result')
      }

      if (result.already_settled !== true) {
        settled += 1
        awarded += awardedCount
        console.info('SHADOW_READ_EVENT_DAILY_SETTLED', {
          starts_on: window.startsOn,
          day_number: day,
          awarded_count: awardedCount,
        })
      }
    }

    return { ok: true, settled_days: settled, awarded_readers: awarded }
  } finally {
    running = false
  }
}

export function startShadowReadEventDailySettlement() {
  if (started || !isEnabled()) return false
  started = true

  async function check() {
    try {
      await settleShadowReadEventDailyTop3Once()
    } catch (error) {
      console.error('SHADOW_READ_EVENT_DAILY_SETTLEMENT_ERROR', {
        code: error?.code || error?.name || 'unknown',
      })
    }
  }

  timer = setInterval(() => { void check() }, POLL_MS)
  timer.unref?.()
  void check()
  return true
}

export function stopShadowReadEventDailySettlement() {
  if (!started) return false
  started = false
  if (timer) clearInterval(timer)
  timer = null
  return true
}
