import { createHash } from 'node:crypto'
import { supabase } from '../config/supabase.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REASONS = Object.freeze({
  repeated_failed_login: { action: 'login_alert', description: 'Multiple unsuccessful sign-in attempts' },
  unusual_device: { action: 'login_alert', description: 'Unusual sign-in device activity' },
  locked_account: { action: 'security_alert', description: 'Account sign-in was temporarily restricted' },
  session_risk: { action: 'security_alert', description: 'Unusual account session activity' },
  security_settings: { action: 'security_alert', description: 'Important security settings changed' },
})

export async function recordReaderActivitySecurityAlert({
  userId,
  reason,
  eventKey,
  occurredAt,
} = {}) {
  const safeUserId = String(userId || '').trim()
  const definition = REASONS[String(reason || '').trim()]
  if (!UUID_PATTERN.test(safeUserId) || !definition) {
    return { ok: false, recorded: false, code: 'INVALID_SECURITY_ACTIVITY' }
  }

  const now = Date.now()
  const suppliedTime = Date.parse(String(occurredAt || ''))
  const eventTime = Number.isFinite(suppliedTime) && suppliedTime <= now + 60000 && suppliedTime >= now - 365 * 86400000
    ? suppliedTime
    : now
  const identity = String(eventKey || `hour:${Math.floor(eventTime / 3600000)}`).slice(0, 512)
  const dedupe = createHash('sha256').update(`${safeUserId}:${reason}:${identity}`).digest('hex')

  try {
    const { error } = await supabase.from('reader_activity_events').insert({
      user_id: safeUserId,
      category: 'security',
      action: definition.action,
      subject_type: 'account',
      subject_id: safeUserId,
      event_key: `reader-security-alert:${dedupe}`,
      description: definition.description,
      occurred_at: new Date(eventTime).toISOString(),
    })

    if (error?.code === '23505') return { ok: true, recorded: false, duplicate: true }
    if (error) {
      console.error('READER_ACTIVITY_SECURITY_ALERT_ERROR', String(error.code || 'WRITE_FAILED'))
      return { ok: false, recorded: false, code: 'WRITE_FAILED' }
    }
    return { ok: true, recorded: true }
  } catch (error) {
    console.error('READER_ACTIVITY_SECURITY_ALERT_ERROR', String(error?.code || 'WRITE_FAILED'))
    return { ok: false, recorded: false, code: 'WRITE_FAILED' }
  }
}
