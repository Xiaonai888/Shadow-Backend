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
