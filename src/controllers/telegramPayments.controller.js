function parseAbaDate(value) {
  const raw = String(value || '').trim()
  if (!raw) return null

  const match = raw.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
  if (!match) return null

  const months = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
    apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
    aug: 7, august: 7, sep: 8, sept: 8, september: 8,
    oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
  }

  const month = months[match[1].toLowerCase()]
  if (month === undefined) return null

  const year = new Date().getUTCFullYear()
  const day = Number(match[2])
  let hour = Number(match[3])
  const minute = Number(match[4])
  const meridiem = match[5].toUpperCase()

  if (meridiem === 'PM' && hour !== 12) hour += 12
  if (meridiem === 'AM' && hour === 12) hour = 0

  const offsetHours = Number(process.env.ABA_ALERT_TIMEZONE_OFFSET_HOURS || 7)
  const utcMs = Date.UTC(year, month, day, hour - offsetHours, minute, 0)

  return new Date(utcMs).toISOString()
}
