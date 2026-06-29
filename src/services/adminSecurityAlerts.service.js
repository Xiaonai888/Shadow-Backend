import { isIP } from 'node:net'
import { supabase } from '../config/supabase.js'

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function normalizeEmail(value) {
  return cleanText(value, 320).toLowerCase()
}

function normalizeSingleIp(value) {
  const raw = cleanText(value, 150).replace(/^::ffff:/, '')
  return isIP(raw) ? raw : ''
}

function getForwardedIp(value) {
  return String(value || '')
    .split(',')
    .map((item) => normalizeSingleIp(item))
    .filter(Boolean)[0] || ''
}

function getUserAgent(req) {
  return cleanText(req.headers['user-agent'], 1000)
}

function countryNameFromCode(countryCode) {
  const code = cleanText(countryCode, 2).toUpperCase()

  if (!code || code === 'XX' || code === 'T1') return ''

  try {
    if (typeof Intl !== 'undefined' && Intl.DisplayNames) {
      const displayNames = new Intl.DisplayNames(['en'], { type: 'region' })
      return displayNames.of(code) || code
    }
  } catch {
    return code
  }

  return code
}

function getAdminIdentity(admin = {}) {
  return {
    adminId: cleanText(admin?.admin_id || admin?.id || '', 120),
    adminEmail: normalizeEmail(admin?.email || ''),
  }
}

function applyAdminAlertOwnerFilter(query, admin = {}) {
  const { adminId, adminEmail } = getAdminIdentity(admin)

  if (adminId && adminEmail) {
    return query.or(`admin_id.eq.${adminId},admin_email.eq.${adminEmail}`)
  }

  if (adminId) return query.eq('admin_id', adminId)

  return query.eq('admin_email', adminEmail)
}

function buildAdminAlertsQuery(admin = {}) {
  return applyAdminAlertOwnerFilter(
    supabase.from('admin_security_alerts').select('*'),
    admin
  )
}

function summarizeAlerts(alerts = []) {
  return {
    total: alerts.length,
    unread: alerts.filter((alert) => !alert.is_read).length,
    critical: alerts.filter((alert) => alert.severity === 'critical').length,
    high: alerts.filter((alert) => alert.severity === 'high').length,
    medium: alerts.filter((alert) => alert.severity === 'medium').length,
    low: alerts.filter((alert) => alert.severity === 'low').length,
  }
}

export function getAdminSecurityClientIp(req) {
  return (
    getForwardedIp(req.headers['cf-connecting-ip'])
    || getForwardedIp(req.headers['x-real-ip'])
    || getForwardedIp(req.headers['x-forwarded-for'])
    || normalizeSingleIp(req.socket?.remoteAddress)
    || 'unknown'
  )
}

export function getAdminRequestCountry(req) {
  const rawCode = (
    cleanText(req.headers['cf-ipcountry'], 2)
    || cleanText(req.headers['x-vercel-ip-country'], 2)
    || cleanText(req.headers['x-country-code'], 2)
    || cleanText(req.headers['cloudfront-viewer-country'], 2)
  )

  const countryCode = cleanText(rawCode, 2).toUpperCase()

  if (!countryCode || countryCode === 'XX' || countryCode === 'T1') {
    return {
      country_code: '',
      country_name: '',
    }
  }

  return {
    country_code: countryCode,
    country_name: countryNameFromCode(countryCode),
  }
}

export async function createAdminSecurityAlert({
  req,
  admin = null,
  email = '',
  deviceId = null,
  sessionId = null,
  alertType = 'security_alert',
  severity = 'medium',
  title = 'Admin security alert',
  message = '',
  metadata = {},
}) {
  try {
    const country = getAdminRequestCountry(req)
    const ipAddress = getAdminSecurityClientIp(req)
    const userAgent = getUserAgent(req)
    const adminEmail = normalizeEmail(admin?.email || email)

    const { error } = await supabase
      .from('admin_security_alerts')
      .insert({
        admin_id: admin?.id || admin?.admin_id || '',
        admin_email: adminEmail,
        device_id: deviceId || null,
        session_id: sessionId || null,
        alert_type: alertType,
        severity,
        title,
        message,
        ip_address: ipAddress,
        user_agent: userAgent,
        country_code: country.country_code,
        country_name: country.country_name,
        is_read: false,
        read_at: null,
        metadata: {
          ...metadata,
          country_code: country.country_code,
          country_name: country.country_name,
        },
        created_at: new Date().toISOString(),
      })

    if (error) {
      console.error('ADMIN SECURITY ALERT INSERT ERROR:', error)
      return false
    }

    return true
  } catch (error) {
    console.error('ADMIN SECURITY ALERT ERROR:', error)
    return false
  }
}

export async function listAdminSecurityAlerts({
  admin,
  limit = 100,
  severity = '',
  readStatus = '',
}) {
  const safeLimit = Math.min(Math.max(Number(limit || 100), 1), 200)
  let query = buildAdminAlertsQuery(admin)
    .order('created_at', { ascending: false })
    .limit(safeLimit)

  if (severity) query = query.eq('severity', cleanText(severity, 30).toLowerCase())
  if (readStatus === 'unread') query = query.eq('is_read', false)
  if (readStatus === 'read') query = query.eq('is_read', true)

  const { data, error } = await query

  if (error) throw error

  const alerts = data || []

  return {
    alerts,
    summary: summarizeAlerts(alerts),
  }
}

export async function markAdminSecurityAlertReadById({ admin, alertId }) {
  const cleanAlertId = cleanText(alertId, 80)

  if (!cleanAlertId) {
    return {
      ok: false,
      status: 400,
      message: 'Alert ID is required',
    }
  }

  let existingQuery = supabase
    .from('admin_security_alerts')
    .select('id')
    .eq('id', cleanAlertId)

  existingQuery = applyAdminAlertOwnerFilter(existingQuery, admin)

  const { data: existing, error: existingError } = await existingQuery.maybeSingle()

  if (existingError) throw existingError

  if (!existing) {
    return {
      ok: false,
      status: 404,
      message: 'Security alert not found',
    }
  }

  const now = new Date().toISOString()

  const { data, error } = await supabase
    .from('admin_security_alerts')
    .update({
      is_read: true,
      read_at: now,
    })
    .eq('id', cleanAlertId)
    .select()
    .single()

  if (error) throw error

  return {
    ok: true,
    alert: data,
  }
}

export async function markAllAdminSecurityAlertsRead({ admin }) {
  let selectQuery = supabase
    .from('admin_security_alerts')
    .select('id')
    .eq('is_read', false)

  selectQuery = applyAdminAlertOwnerFilter(selectQuery, admin)

  const { data: unreadAlerts, error: selectError } = await selectQuery

  if (selectError) throw selectError

  const ids = (unreadAlerts || [])
    .map((alert) => alert.id)
    .filter(Boolean)

  if (!ids.length) {
    return {
      ok: true,
      updated_count: 0,
    }
  }

  const { data, error } = await supabase
    .from('admin_security_alerts')
    .update({
      is_read: true,
      read_at: new Date().toISOString(),
    })
    .in('id', ids)
    .select('id')

  if (error) throw error

  return {
    ok: true,
    updated_count: Array.isArray(data) ? data.length : ids.length,
  }
}
