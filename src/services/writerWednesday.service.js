const WRITER_WEDNESDAY_TIME_ZONE = 'Asia/Phnom_Penh'
const WRITER_WEDNESDAY_AUTHOR_SHARE_PERCENT = 70
const WRITER_WEDNESDAY_PLATFORM_SHARE_PERCENT = 30

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
    timeZone: WRITER_WEDNESDAY_TIME_ZONE,
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

export function getWriterWednesdayEvent(value = new Date()) {
  const now = value instanceof Date ? value : new Date(value)
  const parts = getTimeZoneParts(now)
  const weekdayIndex = WEEKDAY_INDEX[parts.weekday] ?? 0
  const localSeconds =
    Number(parts.hour || 0) * 3600 +
    Number(parts.minute || 0) * 60 +
    Number(parts.second || 0)
  const active = weekdayIndex === 3
  const daysUntilWednesday = (3 - weekdayIndex + 7) % 7
  const secondsUntilStart = active
    ? 0
    : daysUntilWednesday * 86400 - localSeconds
  const secondsUntilEnd = active
    ? 86400 - localSeconds
    : secondsUntilStart + 86400
  const nextStartSeconds = active
    ? 7 * 86400 - localSeconds
    : secondsUntilStart

  return {
    key: 'writer_wednesday',
    name: 'Writer Wednesday',
    active,
    author_share_percent: active
      ? WRITER_WEDNESDAY_AUTHOR_SHARE_PERCENT
      : 0,
    platform_share_percent: active
      ? WRITER_WEDNESDAY_PLATFORM_SHARE_PERCENT
      : 0,
    configured_author_share_percent:
      WRITER_WEDNESDAY_AUTHOR_SHARE_PERCENT,
    configured_platform_share_percent:
      WRITER_WEDNESDAY_PLATFORM_SHARE_PERCENT,
    time_zone: WRITER_WEDNESDAY_TIME_ZONE,
    currencies: ['diamond'],
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

export function getWriterWednesdayAuthorShare(
  value = new Date()
) {
  const event = getWriterWednesdayEvent(value)

  return event.active
    ? WRITER_WEDNESDAY_AUTHOR_SHARE_PERCENT
    : 0
}

export {
  WRITER_WEDNESDAY_AUTHOR_SHARE_PERCENT,
  WRITER_WEDNESDAY_PLATFORM_SHARE_PERCENT,
  WRITER_WEDNESDAY_TIME_ZONE,
}
