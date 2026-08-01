const BLACK_SUNDAY_TIME_ZONE = 'Asia/Phnom_Penh'
const BLACK_SUNDAY_DISCOUNT_PERCENT = 10

const WEEKDAY_INDEX = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

function getTimeZoneParts(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BLACK_SUNDAY_TIME_ZONE,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)

  return parts.reduce((result, part) => {
    if (part.type !== 'literal') {
      result[part.type] = part.value
    }

    return result
  }, {})
}

function getPositiveInteger(value) {
  const number = Number(value)

  if (!Number.isFinite(number) || number <= 0) {
    return 0
  }

  return Math.ceil(number)
}

export function getBlackSundayEvent(value = new Date()) {
  const now = value instanceof Date ? value : new Date(value)
  const parts = getTimeZoneParts(now)
  const weekdayIndex = WEEKDAY_INDEX[parts.weekday] ?? 0
  const localSeconds =
    Number(parts.hour || 0) * 3600 +
    Number(parts.minute || 0) * 60 +
    Number(parts.second || 0)
  const active = weekdayIndex === 0
  const secondsUntilStart = active
    ? 0
    : ((7 - weekdayIndex) % 7) * 86400 - localSeconds
  const secondsUntilEnd = active
    ? 86400 - localSeconds
    : secondsUntilStart + 86400
  const nextStartSeconds = active
    ? 7 * 86400 - localSeconds
    : secondsUntilStart

  return {
    key: 'black_sunday',
    name: 'Black Sunday',
    active,
    discount_percent: active
      ? BLACK_SUNDAY_DISCOUNT_PERCENT
      : 0,
    configured_discount_percent:
      BLACK_SUNDAY_DISCOUNT_PERCENT,
    time_zone: BLACK_SUNDAY_TIME_ZONE,
    currencies: ['diamond', 'coin'],
    starts_in_seconds: active
      ? 0
      : Math.max(0, secondsUntilStart),
    ends_in_seconds: active
      ? Math.max(0, secondsUntilEnd)
      : 0,
    starts_at: new Date(
      now.getTime() +
        Math.max(0, active ? 0 : secondsUntilStart) * 1000
    ).toISOString(),
    ends_at: new Date(
      now.getTime() +
        Math.max(0, secondsUntilEnd) * 1000
    ).toISOString(),
    next_starts_at: new Date(
      now.getTime() +
        Math.max(0, nextStartSeconds) * 1000
    ).toISOString(),
  }
}

export function applyBlackSundayDiscount(
  amount,
  value = new Date()
) {
  const originalAmount = getPositiveInteger(amount)
  const event = getBlackSundayEvent(value)

  if (!event.active || originalAmount <= 0) {
    return {
      original_amount: originalAmount,
      amount: originalAmount,
      discount_amount: 0,
      discount_percent: 0,
      event,
    }
  }

  const discountedAmount = Math.max(
    1,
    Math.ceil(
      originalAmount *
        ((100 - BLACK_SUNDAY_DISCOUNT_PERCENT) / 100)
    )
  )

  return {
    original_amount: originalAmount,
    amount: discountedAmount,
    discount_amount:
      originalAmount - discountedAmount,
    discount_percent:
      BLACK_SUNDAY_DISCOUNT_PERCENT,
    event,
  }
}

export {
  BLACK_SUNDAY_DISCOUNT_PERCENT,
  BLACK_SUNDAY_TIME_ZONE,
}
