const MAX_ACTIVE_INCIDENTS = 500

const activeIncidents = new Map()
const allowedActions = new Set(['watch', 'restrict', 'block', 'isolate'])

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function normalizeSource(value) {
  const source = cleanText(value, 20).toUpperCase()
  return ['WEB', 'ADMIN', 'BACKEND', 'UNKNOWN'].includes(source)
    ? source
    : 'UNKNOWN'
}

function normalizeMethod(value) {
  return cleanText(value, 16).toUpperCase() || 'UNKNOWN'
}

function normalizePath(value) {
  const raw = cleanText(value, 500) || '/'

  return raw
    .split('?')[0]
    .split('/')
    .map((segment) => {
      if (!segment) return segment
      if (/^\d+$/.test(segment)) return ':id'
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segment)) return ':id'
      if (/^[0-9a-f]{16,}$/i.test(segment)) return ':id'
      if (/^[A-Za-z0-9_-]{32,}$/.test(segment)) return ':id'
      return segment.slice(0, 100)
    })
    .join('/') || '/'
}

export function findIpsDefense(incident = {}) {
  const item = activeIncidents.get(fingerprintOf(incident))
  if (!item || item.state !== 'defending') return null
  return cloneIncident(item)
}

unction normalizeIdentityKey(incident = {}) {
  const direct = cleanText(incident.identity_key, 250)
  if (direct) return direct

  const accountId = cleanText(incident.account_id, 200)
  if (accountId) return `account:${accountId}`

  const visitorId = cleanText(incident.visitor_id, 200)
  if (visitorId) return `visitor:${visitorId}`

  const ipAddress = cleanText(incident.ip_address, 150)
  if (ipAddress) return `ip:${ipAddress}`

  return 'unknown'
}

function fingerprintOf(incident = {}) {
  return [
    normalizeIdentityKey(incident),
    normalizeSource(incident.source),
    normalizeMethod(incident.method),
    normalizePath(incident.path),
  ].join('|')
}


function safeNumber(value) {
  return Math.max(0, Math.round(Number(value) || 0))
}

function cloneIncident(item) {
  return item ? { ...item } : null
}

function evictOldestIncident() {
  let oldestKey = ''
  let oldestAt = Infinity

  for (const [key, item] of activeIncidents.entries()) {
    if (item.last_signal_at < oldestAt) {
      oldestAt = item.last_signal_at
      oldestKey = key
    }
  }

  if (oldestKey) activeIncidents.delete(oldestKey)
}

export function wakeIps(incident = {}) {
  const now = Date.now()
  const fingerprint = fingerprintOf(incident)
  let item = activeIncidents.get(fingerprint)

  if (!item) {
    if (activeIncidents.size >= MAX_ACTIVE_INCIDENTS) {
      evictOldestIncident()
    }

    item = {
       fingerprint,
      identity_key: normalizeIdentityKey(incident),
      identity_type: cleanText(incident.identity_type, 20) || 'unknown',
      account_id: cleanText(incident.account_id, 200) || null,
      visitor_id: cleanText(incident.visitor_id, 200) || null,
      ip_address: cleanText(incident.ip_address, 150) || null,
      source: normalizeSource(incident.source),
      method: normalizeMethod(incident.method),
      path: normalizePath(incident.path),
      state: 'awake',
      action: 'watch',
      wake_count: 0,
      estimated_requests_per_minute: 0,
      peak_requests_per_minute: 0,
      first_wake_at: now,
      last_signal_at: now,
    }

    activeIncidents.set(fingerprint, item)
  }

  item.state = item.state === 'defending' ? 'defending' : 'awake'
  item.wake_count += 1
  item.last_signal_at = now
  item.estimated_requests_per_minute = safeNumber(
    incident.estimated_requests_per_minute
  )
  item.peak_requests_per_minute = Math.max(
    item.peak_requests_per_minute,
    safeNumber(incident.peak_requests_per_minute),
    item.estimated_requests_per_minute
  )

  return cloneIncident(item)
}

export function defendIps(incident = {}, action = 'restrict') {
  const awakened = wakeIps(incident)
  const item = activeIncidents.get(awakened.fingerprint)
  const normalizedAction = cleanText(action, 20).toLowerCase()

  item.state = 'defending'
  item.action = allowedActions.has(normalizedAction)
    ? normalizedAction
    : 'restrict'
  item.last_signal_at = Date.now()

  return cloneIncident(item)
}

export function releaseIps(incident = {}) {
  const fingerprint = fingerprintOf(incident)
  const item = activeIncidents.get(fingerprint)

  if (!item) return null

  activeIncidents.delete(fingerprint)

  return {
    ...item,
    state: 'released',
    released_at: Date.now(),
  }
}

export function isIpsSleeping() {
  return activeIncidents.size === 0
}

export function getIpsSnapshot() {
  return {
    state: isIpsSleeping() ? 'sleeping' : 'awake',
    active_count: activeIncidents.size,
    incidents: [...activeIncidents.values()]
      .map(cloneIncident)
      .sort((a, b) => b.last_signal_at - a.last_signal_at),
  }
}
