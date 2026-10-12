import { createHash } from 'node:crypto'
import { createAdminSecurityAlert } from './adminSecurityAlerts.service.js'

const blockedWindowMs = 6 * 60 * 60 * 1000
const newBrowserWindowMs = 24 * 60 * 60 * 1000
const maxKeys = 500
const seen = new Map()

function allowOnce(value, windowMs) {
  const now = Date.now()
  const key = createHash('sha256').update(String(value)).digest('hex')
  const previous = seen.get(key)
  if (previous && now - previous < windowMs) return false
  for (const [oldKey, time] of seen) {
    if (now - time >= newBrowserWindowMs) seen.delete(oldKey)
  }
  while (seen.size >= maxKeys) seen.delete(seen.keys().next().value)
  seen.set(key, now)
  return true
}

export function shouldSendRepeatedBlockedAlert(ctx, payload = {}) {
  const type = String(payload.alertType || 'admin_login_blocked')
  const identity = String(ctx?.guardKey || ctx?.ipAddress || 'unknown')
  const status = String(payload.block_status || '')
  return allowOnce(`blocked:${type}:${identity}:${status}`, blockedWindowMs)
}

export async function alertNewAdminBrowserLogin({ req, admin, ctx, deviceId }) {
  if (!admin || ctx?.trustedDevice) return false

  const adminEmail = String(admin.email || ctx?.attemptedEmail || '').trim().toLowerCase()
  const identity = deviceId || `${ctx?.ipAddress || 'unknown'}:${ctx?.userAgent || 'unknown'}`
  if (!allowOnce(`new-browser:${adminEmail}:${identity}`, newBrowserWindowMs)) return false

  return createAdminSecurityAlert({
    req,
    admin,
    email: adminEmail,
    deviceId: deviceId || null,
    alertType: 'admin_new_browser_login_success',
    severity: 'high',
    title: 'New admin browser login succeeded',
    message: 'An admin account successfully signed in from a browser not previously trusted by Login Guard. Review whether this was you.',
    metadata: {
      event: 'login_success',
      evidence_only: true,
      previously_trusted_browser: false,
      trusted_ip: Boolean(ctx?.trustedIp),
      guard_key: String(ctx?.guardKey || ''),
      country_code: String(ctx?.countryCode || ''),
      country_name: String(ctx?.countryName || ''),
    },
  })
}
