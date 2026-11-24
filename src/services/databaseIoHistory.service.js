import { databaseIoArchiveConfigured, readDatabaseIoObject, writeDatabaseIoObject } from './databaseIoArchiveStorage.service.js'
import { databaseIoDay, databaseIoDayRange, databaseIoIntervalId, mergeDatabaseIoDay, summarizeDatabaseIoDay } from './databaseIoDailySummary.service.js'

const PREFIX = 'database-io/v1'
let pending = null, lastSaved = null, lastError = null, failures = 0, retryAfter = 0
let reading = false
const dailyKey = day => `${PREFIX}/daily/${day}.json.gz`
const detailKey = (day, id) => `${PREFIX}/detail/${day}/${id}.json.gz`

export function getDatabaseIoArchiveState() {
  return { configured: databaseIoArchiveConfigured(), writing: Boolean(pending), last_saved: lastSaved, last_error: lastError, consecutive_failures: failures, retry_after: retryAfter ? new Date(retryAfter).toISOString() : null, single_writer_required: true, detail_retention_days: 30, daily_retention_days: 365, lifecycle_configuration_required: true }
}

export async function archiveDatabaseIoInterval(interval) {
  if (!databaseIoArchiveConfigured()) return { saved: false, reason: 'not_configured' }
  if (pending || Date.now() < retryAfter) return { saved: false, reason: pending ? 'busy' : 'backoff' }
  const day = databaseIoDay(interval.to), id = databaseIoIntervalId(interval)
  pending = (async () => {
    try {
      await writeDatabaseIoObject(detailKey(day, id), { version: 1, interval })
      const old = await readDatabaseIoObject(dailyKey(day))
      await writeDatabaseIoObject(dailyKey(day), mergeDatabaseIoDay(old, interval))
      lastSaved = interval.to
      lastError = null
      failures = 0
      retryAfter = 0
      return { saved: true, id, day }
    } catch {
      failures++
      lastError = { at: new Date().toISOString(), kind: 'archive_write_failed' }
      retryAfter = Date.now() + Math.min(15 * 60000 * 2 ** Math.min(failures - 1, 2), 3600000)
      return { saved: false, reason: lastError.kind }
    }
  })()
  try { return await pending } finally { pending = null }
}

export async function getDatabaseIoDailyHistory(days = 7) {
  const dates = databaseIoDayRange(days)
  if (!databaseIoArchiveConfigured()) return { status: 'not_configured', days: [] }
  if (reading) return { status: 'busy', days: [] }
  reading = true
  const result = []
  try {
    for (const day of dates) {
      try {
        const record = await readDatabaseIoObject(dailyKey(day))
        result.push(record ? { status: 'available', ...summarizeDatabaseIoDay(record) } : { day, status: 'missing' })
      } catch { result.push({ day, status: 'unavailable' }); break }
    }
    return { status: result.length === dates.length && result.every(row => row.status === 'available') ? 'available' : 'partial', days: result, requested_days: dates, archive: getDatabaseIoArchiveState() }
  } finally { reading = false }
}

export async function getDatabaseIoArchivedInterval(from, to) {
  const id = databaseIoIntervalId({ from, to, status: 'observed' })
  if (Date.now() - Date.parse(to) > 30 * 86400000 || Date.parse(to) > Date.now()) return null
  const record = await readDatabaseIoObject(detailKey(databaseIoDay(to), id))
  if (!record) return null
  if (record.version !== 1 || databaseIoIntervalId(record.interval) !== id) throw new Error('IO_ARCHIVE_INVALID_DETAIL')
  return record.interval
}
