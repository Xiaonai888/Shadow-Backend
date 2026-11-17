const DAY_MS = 86400000
const FIRST_START_MS = Date.UTC(2026, 10, 2)
const CYCLE_DAYS = 14
const ACTIVE_DAYS = 7
const PREPARE_DAYS = 2

function dateKey(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

export function getShadowReadEventAutoCycleWindow(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return null

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Phnom_Penh', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const part = (type) => parts.find((value) => value.type === type)?.value
  const today = `${part('year')}-${part('month')}-${part('day')}`
  const todayMs = Date.parse(`${today}T00:00:00.000Z`)
  const elapsed = (todayMs - FIRST_START_MS) / DAY_MS
  if (!Number.isInteger(elapsed) || elapsed < 0) return null

  const cycleDay = elapsed % CYCLE_DAYS
  const cycleStartMs = todayMs - cycleDay * DAY_MS

  if (cycleDay < ACTIVE_DAYS) {
    return {
      startsOn: dateKey(cycleStartMs),
      shouldEnable: true,
      dayNumber: cycleDay + 1,
      today,
    }
  }

  if (cycleDay >= CYCLE_DAYS - PREPARE_DAYS) {
    return {
      startsOn: dateKey(cycleStartMs + CYCLE_DAYS * DAY_MS),
      shouldEnable: false,
      dayNumber: null,
      today,
    }
  }

  return null
}
