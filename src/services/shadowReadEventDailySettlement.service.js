import { supabase } from '../config/supabase.js'

const DAY_MS = 86400000
const FIRST_EVENT_MS = Date.UTC(2026, 10, 2)
const CYCLE_DAYS = 14
const EVENT_DAYS = 7
const CAMBODIA_OFFSET_MS = 7 * 60 * 60 * 1000
const POLL_MS = 15 * 60 * 1000

let started = false
let running = false
let timer = null
let overallSettledEventId = null
let participationCompletedEventId = null

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

async function settleOverallTop3(eventId, startsOn) {
  if (overallSettledEventId === eventId) {
    return { settled: false, awarded: 0, already_settled: true }
  }

  const { data: existing, error: existingError } = await supabase
    .from('shadow_read_event_overall_settlements')
    .select('event_id')
    .eq('event_id', eventId)
    .maybeSingle()

  if (existingError) throw existingError
  if (existing) {
    overallSettledEventId = eventId
    return { settled: false, awarded: 0, already_settled: true }
  }

  const { data, error } = await supabase.rpc('shadow_read_event_settle_overall_top3', {
    p_event_id: eventId,
  })
  if (error) throw error

  const result = Array.isArray(data) ? data[0] : data
  const awardedCount = Number(result?.awarded_count)
  if (!result || result.ok !== true || result.settled !== true ||
      typeof result.already_settled !== 'boolean' ||
      String(result.event_id) !== String(eventId) ||
      !Number.isInteger(awardedCount) || awardedCount < 0 || awardedCount > 3 ||
      !Array.isArray(result.winners) || result.winners.length !== awardedCount) {
    throw new Error('Invalid Read Event Overall Top 3 settlement result')
  }

  overallSettledEventId = eventId
  if (result.already_settled !== true) {
    console.info('SHADOW_READ_EVENT_OVERALL_SETTLED', {
      starts_on: startsOn,
      awarded_count: awardedCount,
    })
  }

  return {
    settled: result.already_settled !== true,
    awarded: result.already_settled ? 0 : awardedCount,
    already_settled: result.already_settled,
  }
}

async function settleParticipationRewards(eventId, startsOn) {
  if (participationCompletedEventId === eventId) {
    return { awarded: 0, complete: true }
  }

  const { data, error } = await supabase.rpc('shadow_read_event_settle_participation', {
    p_event_id: eventId,
    p_limit: 30,
  })
  if (error) throw error

  const result = Array.isArray(data) ? data[0] : data
  const awarded = Number(result?.awarded_count)
  const coins = Number(result?.coins_added)
  const vouchers = Number(result?.vouchers_added)
  const cards = Number(result?.story_cards_added)

  if (!result || result.ok !== true || String(result.event_id) !== String(eventId) ||
      !Number.isSafeInteger(awarded) || awarded < 0 || awarded > 30 ||
      !Number.isSafeInteger(coins) || coins < awarded * 100 || coins > awarded * 1000 ||
      vouchers !== awarded * 10 || cards !== awarded * 10 ||
      typeof result.has_more !== 'boolean' || typeof result.complete !== 'boolean' ||
      result.complete === result.has_more || (awarded === 0 && !result.complete)) {
    throw new Error('Invalid Read Event participation settlement result')
  }

  if (awarded > 0) {
    console.info('SHADOW_READ_EVENT_PARTICIPATION_BATCH', {
      starts_on: startsOn,
      awarded_count: awarded,
      complete: result.complete,
    })
  }

  if (result.complete) {
    participationCompletedEventId = eventId
    console.info('SHADOW_READ_EVENT_PARTICIPATION_COMPLETE', { starts_on: startsOn })
  }

  return { awarded, complete: result.complete }
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

    if (window.lastClosedDay === EVENT_DAYS &&
        participationCompletedEventId === event.id) {
      return {
        ok: true,
        settled_days: 0,
        awarded_readers: 0,
        overall_settled: false,
        overall_awarded_readers: 0,
        participation_awarded_readers: 0,
        participation_complete: true,
      }
    }

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

      settledDays.add(day)
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

    let overall = { settled: false, awarded: 0, already_settled: false }
    let participation = { awarded: 0, complete: false }
    if (window.lastClosedDay === EVENT_DAYS &&
        settledDays.size === EVENT_DAYS) {
      overall = await settleOverallTop3(event.id, window.startsOn)
      participation = await settleParticipationRewards(event.id, window.startsOn)
    }

    return {
      ok: true,
      settled_days: settled,
      awarded_readers: awarded,
      overall_settled: overall.settled,
      overall_awarded_readers: overall.awarded,
      participation_awarded_readers: participation.awarded,
      participation_complete: participation.complete,
    }
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
      console.error('SHADOW_READ_EVENT_SETTLEMENT_ERROR', {
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
