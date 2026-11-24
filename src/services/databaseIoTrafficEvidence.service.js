const MINUTE = 60000
const RETENTION = 65
const CAP = 80
const buckets = new Map()
let enabledAt = null
const methods = new Set(['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'])
function routeName(value) {
  const s = String(value || '')
  if (s === 'BACKGROUND') return s
  const m = /^([A-Z]+) (\/api(?:\/[a-zA-Z0-9_:-]+){1,10})$/.exec(s)
  if (!m || !methods.has(m[1]) || s.length > 180) return 'UNCLASSIFIED'
  return `${m[1]} ${m[2].split('/').map(x => /^\d+$|^[a-f0-9-]{20,}$|^[a-zA-Z0-9_-]{25,}$/.test(x) ? ':id' : x).join('/')}`
}
function targetName(value) {
  const m = /^SUPABASE ([A-Z]+) \/rest\/v1\/(rpc\/)?([a-zA-Z_][a-zA-Z0-9_]{0,62})\/?$/.exec(String(value || ''))
  if (!m || !methods.has(m[1])) return { target: 'OTHER_SUPABASE', identifier: null }
  return { target: `${m[1]} ${m[2] || ''}${m[3]}`, identifier: m[3].toLowerCase() }
}
function bucketAt(now) {
  const minute = Math.floor(now / MINUTE) * MINUTE
  for (const key of buckets.keys()) if (key <= minute - RETENTION * MINUTE) buckets.delete(key)
  if (!buckets.has(minute)) buckets.set(minute, { rows: new Map(), dropped: 0 })
  return buckets.get(minute)
}
export function enableDatabaseIoTrafficEvidence() { if (enabledAt === null) enabledAt = Date.now() }
export function recordDatabaseIoTraffic({ kind, route, target, status, durationMs } = {}) {
  try {
    if (enabledAt === null || !['http','supabase'].includes(kind)) return
    const b = bucketAt(Date.now())
    const r = routeName(route)
    const t = kind === 'supabase' ? targetName(target) : { target: null, identifier: null }
    const key = `${kind}|${r}|${t.target || ''}`
    if (!b.rows.has(key)) {
      if (b.rows.size >= CAP) { b.dropped++; return }
      b.rows.set(key, { kind, route: r, ...t, calls: 0, errors: 0, server_errors: 0, gateway_timeouts: 0, transport_errors: 0, duration_ms: 0, max_ms: 0 })
    }
    const row = b.rows.get(key), code = Number(status), ms = Number(durationMs)
    row.calls++
    if (code >= 400 || code === 0) row.errors++
    if (code >= 500 && code <= 599) row.server_errors++
    if (code === 504) row.gateway_timeouts++
    if (code === 0) row.transport_errors++
    if (Number.isFinite(ms) && ms >= 0) { row.duration_ms += ms; row.max_ms = Math.max(row.max_ms, ms) }
  } catch {}
}
export function getDatabaseIoTrafficEvidence(from, to) {
  const start = Date.parse(from), end = Date.parse(to), now = Date.now()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return { status:'invalid_window', rows: [] }
  if (enabledAt === null) return { status:'not_connected', rows: [] }
  const lower = Math.max(start, enabledAt, Math.floor(now / MINUTE) * MINUTE - (RETENTION - 1) * MINUTE)
  const upper = Math.min(end, now)
  const totals = new Map()
  let dropped = 0, boundaryEvents = 0
  for (const [minute, b] of buckets) {
    if (minute + MINUTE <= lower || minute >= upper || upper <= lower) continue
    dropped += b.dropped
    for (const [key, row] of b.rows) {
      if (minute < lower || minute + MINUTE > upper) { boundaryEvents += row.calls; continue }
      if (!totals.has(key)) totals.set(key, { ...row })
      else {
        const dst = totals.get(key)
        for (const k of ['calls','errors','server_errors','gateway_timeouts','transport_errors','duration_ms']) dst[k] += row[k]
        dst.max_ms = Math.max(dst.max_ms,row.max_ms)
      }
    }
  }
  const all = [...totals.values()]
  const chosen = new Map()
  for (const kind of ['http','supabase']) {
    const rows = all.filter(r => r.kind === kind)
    for (const metric of ['calls','errors','duration_ms','gateway_timeouts']) {
      for (const r of [...rows].sort((a,b)=>b[metric]-a[metric]).slice(0,20)) chosen.set(`${r.kind}|${r.route}|${r.target}`,r)
    }
  }
  return { status: lower > start || upper < end || dropped || boundaryEvents || chosen.size < all.length ? 'partial' : 'observed', from, to, enabled_at: new Date(enabledAt).toISOString(), dropped_events: dropped, excluded_boundary_events: boundaryEvents, retained_rows: chosen.size, observed_groups: all.length, rows: [...chosen.values()], note:'Completed calls observed by installed hooks only. Full minute buckets only; no user IDs or request bodies. Background target does not prove worker ownership.' }
}
