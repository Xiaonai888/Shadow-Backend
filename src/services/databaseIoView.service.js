import { getDatabaseIoReport } from './databaseIoMonitor.service.js'
import { getDatabaseIoArchiveState } from './databaseIoHistory.service.js'
import { readDatabaseIoObject } from './databaseIoArchiveStorage.service.js'
import { databaseIoDay, compactDatabaseIoInterval, summarizeDatabaseIoDay } from './databaseIoDailySummary.service.js'

const DAY = 86400000
const OFFSET = 7 * 3600000
const TTL = 10 * 60000
const METRICS = ['calls','rows','exec_ms','read_bytes','hit_bytes','dirty_bytes','written_bytes','temp_read_bytes','temp_written_bytes','wal_bytes']
const cache = new Map()
let pending = null
let retryAfter = 0
const blank = () => Object.fromEntries(METRICS.map(k => [k, null]))
function add(total, row) {
  for (const k of METRICS) if (typeof row?.[k] === 'number' && Number.isFinite(row[k]) && row[k] >= 0) total[k] = (total[k] ?? 0) + row[k]
}
function parseTime(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return NaN
  return /^\d{13}$/.test(String(value)) ? Number(value) : /^\d{4}-\d{2}-\d{2}T/.test(String(value)) ? Date.parse(value) : NaN
}
export function normalizeDatabaseIoViewRange(from, to, now = Date.now()) {
  const a = parseTime(from), b = parseTime(to)
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1000000000000 || b <= a || b > now + 60000 || b - a > 30 * DAY) return null
  const end = Math.min(b, now)
  if (end <= a) return null
  return { from:a, to:end }
}
function datesFor(range) {
  const first = Math.floor((range.from + OFFSET) / DAY) * DAY
  const last = Math.floor((range.to + OFFSET) / DAY) * DAY
  const dates = []
  for (let ms = first; ms <= last; ms += DAY) dates.push(new Date(ms).toISOString().slice(0,10))
  return dates
}
function summarizeDay(day, archive, live, range, archiveStatus) {
  if (archive && (archive.version !== 1 || archive.day !== day || !Array.isArray(archive.intervals) || archive.intervals.length > 128)) throw new Error('INVALID_IO_DAY')
  const rows = new Map()
  for (const row of archive?.intervals || []) rows.set(row.id,row)
  for (const row of live) if (databaseIoDay(row.to) === day) rows.set(row.id,row)
  let boundary = 0
  const intervals = [...rows.values()].filter(row => {
    const start = Date.parse(row.from), end = Date.parse(row.to)
    if (end <= range.from || start >= range.to) return false
    if (start < range.from || end > range.to) { boundary++; return false }
    return true
  })
  const result = summarizeDatabaseIoDay({version:1, day, timezone:'Asia/Phnom_Penh', allocation:'interval_end_day', intervals})
  return {...result, archive_status:archiveStatus, excluded_boundary_intervals:boundary}
}
function combine(days, range) {
  const totals = blank(), features = new Map()
  let covered = 0, intervals = 0, partial = 0, missing = 0, overlaps = 0, boundary = 0, crossDay = 0
  for (const day of days) {
    add(totals,day.totals)
    for (const f of day.features) { if (!features.has(f.feature)) features.set(f.feature,blank()); add(features.get(f.feature),f) }
    covered += day.coverage.covered_seconds
    intervals += day.coverage.intervals
    partial += day.coverage.partial
    missing += day.coverage.missing
    overlaps += day.coverage.overlaps_excluded
    crossDay += day.coverage.cross_day_intervals
    boundary += day.excluded_boundary_intervals
  }
  const duration = (range.to-range.from)/1000
  return { totals, features:[...features].map(([feature,value])=>({feature,...value})).sort((a,b)=>(b.read_bytes ?? -1)-(a.read_bytes ?? -1)), days:days.map(({features,...day})=>day), coverage:{ intervals, partial, missing, overlaps_excluded:overlaps, cross_day_intervals:crossDay, boundary_intervals_excluded:boundary, covered_seconds:covered, requested_seconds:duration, approximate_uncovered_seconds:Math.max(0,duration-covered) }, cache_hit_percent:totals.hit_bytes !== null && totals.read_bytes !== null && totals.hit_bytes+totals.read_bytes > 0 ? 100*totals.hit_bytes/(totals.hit_bytes+totals.read_bytes) : null }
}
function liveRows(report) {
  return report.intervals.map(compactDatabaseIoInterval)
}
async function loadArchive(range, live, dates) {
  const days = []
  let failed = false
  for (const day of dates) {
    let archive = null, status = failed ? 'not_checked' : 'missing'
    if (!failed) {
      try { archive = await readDatabaseIoObject(`database-io/v1/daily/${day}.json.gz`); status = archive ? 'available' : 'missing' }
      catch { failed = true; status = 'unavailable' }
    }
    try { days.push(summarizeDay(day,archive,live,range,status)) }
    catch { failed = true; days.push(summarizeDay(day,null,live,range,'invalid')) }
  }
  if (failed) retryAfter = Date.now()+60000
  return { ...combine(days,range), archive_read_status:failed ? 'partial' : 'checked', captured_at:new Date().toISOString() }
}
export function getDatabaseIoView(range) {
  const report = getDatabaseIoReport(), live = liveRows(report), dates = datesFor(range)
  const archive = getDatabaseIoArchiveState()
  const key = `${range.from}:${range.to}`
  const now = Date.now()
  for (const [k,v] of cache) if (v.until <= now) cache.delete(k)
  const entry = cache.get(key)
  let summary = entry?.value || combine(dates.map(day=>summarizeDay(day,null,live,range,archive.configured?'not_checked':'not_configured')),range)
  let archiveReadStatus = entry?.value?.archive_read_status || (archive.configured?'pending':'not_configured')
  if (archive.configured && !entry && !pending && now >= retryAfter) {
    const work = loadArchive(range,live,dates).then(value=>{
      if (cache.size >= 3) cache.delete(cache.keys().next().value)
      cache.set(key,{value,until:Date.now()+(value.archive_read_status==='partial'?60000:TTL)})
    }).catch(()=>{ retryAfter=Date.now()+60000 }).finally(()=>{ if (pending===work) pending=null })
    pending=work
  }
  if (archive.configured && !entry && !pending && now < retryAfter) archiveReadStatus='backoff'
  const last = [...report.intervals].reverse().find(i=>Date.parse(i.to)<=range.to && Date.parse(i.from)>=range.from && i.totals)
  const top = (last?.top_queries || []).slice().sort((a,b)=>b.read_bytes-a.read_bytes).slice(0,10)
  return { mode:'monitoring_only', range:{from:new Date(range.from).toISOString(),to:new Date(range.to).toISOString()}, state:report.state, archive, archive_read_status:archiveReadStatus, ...summary, disk_io_balance_percent:null, top_queries_latest_interval:top, latest_query_interval:last?{from:last.from,to:last.to,status:last.status}:null, interpretation:{buffer_read:'PostgreSQL buffer reads; OS cache may satisfy some reads.',buffer_write:'Statement-attributed buffer writes; excludes other writers.',wal:'WAL generated, not physical disk writes.',cache:'PostgreSQL shared-buffer hit rate for retained statements.',feature:'Candidate feature inferred from known SQL identifiers.',coverage:'Full intervals only, assigned to their ending day; cross-midnight intervals can include activity from the previous day. Missing periods are not zero. Historical view contains aggregates; top queries are from the latest retained in-memory interval only.'} }
}
