import { createHash } from 'node:crypto'

const WRITE_INTERVAL_MS = 20_000
const MAX_SESSIONS = 6_000
const IDLE_TTL_MS = 5 * 60_000
const REPORT_WINDOW_MS = 15 * 60_000
const sessions = new Map()
let reportWindow = Math.floor(Date.now() / REPORT_WINDOW_MS) * REPORT_WINDOW_MS
let sent = 0
let skipped = 0

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function record(kind, now) {
  const window = Math.floor(now / REPORT_WINDOW_MS) * REPORT_WINDOW_MS
  if (window !== reportWindow) {
    if (sent || skipped) {
      console.info('READER_PRESENCE_WRITE_GATE_15M', JSON.stringify({
        from: new Date(reportWindow).toISOString(),
        to: new Date(reportWindow + REPORT_WINDOW_MS).toISOString(),
        forwarded_to_controller: sent,
        duplicate_heartbeats_skipped: skipped,
        estimated_duplicate_write_avoidance_percent:
          Number((skipped * 100 / (sent + skipped)).toFixed(1)),
        scope: 'single_backend_process',
      }))
    }
    reportWindow = window
    sent = 0
    skipped = 0
  }
  if (kind === 'skipped') skipped += 1
  else sent += 1
}

function prune(now) {
  for (const [key, session] of sessions) {
    if (now - session.touchedAt <= IDLE_TTL_MS) break
    sessions.delete(key)
  }
  while (sessions.size > MAX_SESSIONS) {
    sessions.delete(sessions.keys().next().value)
  }
}

function pathFromBody(value) {
  const raw = String(value || '/').trim().slice(0, 500)
  const path = raw.split(/[?#]/)[0] || '/'
  return path.startsWith('/') ? path : `/${path}`
}

export function readerPresenceWriteGate(req, res, next) {
  const userId = String(req.user?.user_id || '').trim()
  const sessionId = String(req.body?.session_id || '').trim().slice(0, 120)
  if (!userId || !sessionId) return next()

  const now = Date.now()
  const key = hash(`${userId}\u001f${sessionId}`)
  const isActive = req.body?.is_active !== false
  const visibility = String(req.body?.visibility_state || '').toLowerCase() === 'hidden'
    ? 'hidden'
    : 'visible'
  const fingerprint = hash([
    pathFromBody(req.body?.current_path),
    visibility,
    String(isActive),
    String(req.headers['user-agent'] || '').slice(0, 1000),
  ].join('\u001f'))

  let session = sessions.get(key)
  if (!session) {
    session = { generation: 0, fingerprint: '', expiresAt: 0, touchedAt: now }
  }
  sessions.delete(key)
  session.touchedAt = now
  sessions.set(key, session)
  prune(now)

  if (isActive && visibility === 'visible' &&
      session.fingerprint === fingerprint && session.expiresAt > now) {
    record('skipped', now)
    res.setHeader('X-Shadow-Presence-Write', 'skipped-duplicate')
    return res.status(200).json({ ok: true })
  }

  session.generation += 1
  const generation = session.generation
  session.fingerprint = ''
  session.expiresAt = 0
  record('forwarded', now)
  res.setHeader('X-Shadow-Presence-Write', 'forwarded')

  if (isActive && visibility === 'visible') {
    res.once('finish', () => {
      if (res.statusCode !== 200 || sessions.get(key) !== session ||
          session.generation !== generation) return
      session.fingerprint = fingerprint
      session.expiresAt = Date.now() + WRITE_INTERVAL_MS
    })
  }

  return next()
}
