import { isIP } from 'node:net'
import { publishSecurityEvent } from '../services/securityControlPlane.service.js'

const WINDOW_MS = 10 * 60 * 1000
const MAX_EVENT_KEYS = 256
const MAX_EVENTS_PER_MINUTE = 12
const recentEvents = new Map()
let currentMinute = -1
let eventsThisMinute = 0

function text(value, limit = 300) {
  return String(value || '').trim().slice(0, limit)
}

function parseIp(value) {
  const candidate = text(value, 150).replace(/^::ffff:/, '')
  return isIP(candidate) ? candidate : ''
}

function firstForwardedIp(value) {
  return String(value || '').split(',').map(parseIp).find(Boolean) || ''
}

function hostnameOf(value) {
  try {
    const input = text(value, 255)
    return new URL(input.includes('://') ? input : `http://${input}`).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function isAdminRoute(path) {
  return path === '/api/admin'
    || path.startsWith('/api/admin/')
    || path.startsWith('/api/auth/')
}

function eventAllowed(key) {
  const now = Date.now()
  const minute = Math.floor(now / 60000)

  if (minute !== currentMinute) {
    currentMinute = minute
    eventsThisMinute = 0
  }

  if (eventsThisMinute >= MAX_EVENTS_PER_MINUTE) return false
  if (now - (recentEvents.get(key) || 0) < WINDOW_MS) return false

  for (const [previousKey, recordedAt] of recentEvents) {
    if (now - recordedAt >= WINDOW_MS) recentEvents.delete(previousKey)
  }

  while (recentEvents.size >= MAX_EVENT_KEYS) {
    recentEvents.delete(recentEvents.keys().next().value)
  }

  recentEvents.set(key, now)
  eventsThisMinute += 1
  return true
}

export function backendOriginAudit(req, res, next) {
  const path = text(req.originalUrl || req.url || req.path, 1024).split('?')[0]
  if (!isAdminRoute(path)) return next()

  const host = hostnameOf(req.headers.host)
  const directRenderHost = host.endsWith('.onrender.com')
  const cloudflareIpHeader = text(req.headers['cf-connecting-ip'], 150)
  const cloudflareRay = text(req.headers['cf-ray'], 120)
  const cloudflareCountry = text(req.headers['cf-ipcountry'], 2)
  const otherCloudflareHeader = Boolean(req.headers['true-client-ip'])
  const claimsCloudflare = Boolean(cloudflareIpHeader || cloudflareRay || cloudflareCountry || otherCloudflareHeader)
  const claimedIp = parseIp(cloudflareIpHeader)
  const forwardedIp = firstForwardedIp(req.headers['x-forwarded-for'])
  const inconsistentIpClaims = Boolean(claimedIp && forwardedIp && claimedIp !== forwardedIp)

  res.once('finish', () => {
    const deniedAdminRequest = directRenderHost && res.statusCode === 403
    const unverifiedCloudflareHeaders = directRenderHost && claimsCloudflare
    if (!deniedAdminRequest && !unverifiedCloudflareHeaders) return

    const signal = unverifiedCloudflareHeaders
      ? 'backend_unverified_cloudflare_headers'
      : 'backend_direct_admin_denied'
    const identity = forwardedIp || claimedIp || parseIp(req.socket?.remoteAddress) || 'unknown'
    const eventKey = `${signal}|${identity}|${path}`
    if (!eventAllowed(eventKey)) return

    const payload = {
      host,
      path,
      method: text(req.method, 12),
      status: res.statusCode,
      forwarded_ip_unverified: forwardedIp || null,
      cloudflare_ip_unverified: claimedIp || null,
      transport_peer_ip: parseIp(req.socket?.remoteAddress) || null,
      user_agent: text(req.headers['user-agent'], 350) || null,
      request_origin: hostnameOf(req.headers.origin) || null,
      cloudflare_ray_unverified: cloudflareRay || null,
      cloudflare_country_unverified: cloudflareCountry || null,
      inconsistent_ip_claims: inconsistentIpClaims,
      direct_render_hostname: directRenderHost,
      evidence_only: true,
    }

    publishSecurityEvent({
      source: 'control_plane',
      target: 'all',
      type: signal,
      severity: inconsistentIpClaims ? 'high' : unverifiedCloudflareHeaders ? 'medium' : 'low',
      payload,
    })

    console.warn('BACKEND_ORIGIN_AUDIT', JSON.stringify({ signal, ...payload }))
  })

  return next()
}
