import { isIP } from 'node:net'
import { supabase } from '../config/supabase.js'

const requestBuckets = new Map()

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength)
}

function normalizeIp(value) {
  const raw = cleanText(value, 80).split(',')[0].trim().replace(/^::ffff:/, '')
  return isIP(raw) ? raw : ''
}

function getClientIp(req) {
  return normalizeIp(
    req.headers['cf-connecting-ip']
      || req.headers['x-forwarded-for']
      || req.socket?.remoteAddress
      || ''
  )
}

function getDeviceInfo(userAgent) {
  const ua = String(userAgent || '')
  const isBot = /bot|crawler|spider|slurp|bingpreview|headless|phantom|python|curl|wget|scrapy|httpclient/i.test(ua)

  let deviceType = 'Desktop'
  if (isBot) deviceType = 'Bot'
  else if (/ipad|tablet|kindle|silk|playbook/i.test(ua)) deviceType = 'Tablet'
  else if (/mobile|iphone|ipod|android/i.test(ua)) deviceType = 'Mobile'

  let browser = 'Unknown'
  if (/edg\//i.test(ua)) browser = 'Edge'
  else if (/opr\//i.test(ua)) browser = 'Opera'
  else if (/samsungbrowser\//i.test(ua)) browser = 'Samsung Internet'
  else if (/chrome|crios/i.test(ua)) browser = 'Chrome'
  else if (/firefox|fxios/i.test(ua)) browser = 'Firefox'
  else if (/safari/i.test(ua)) browser = 'Safari'

  let operatingSystem = 'Unknown'
  if (/windows nt/i.test(ua)) operatingSystem = 'Windows'
  else if (/android/i.test(ua)) operatingSystem = 'Android'
  else if (/iphone|ipad|ipod/i.test(ua)) operatingSystem = 'iOS'
  else if (/mac os x|macintosh/i.test(ua)) operatingSystem = 'macOS'
  else if (/linux/i.test(ua)) operatingSystem = 'Linux'

  return {
    deviceType,
    browser,
    operatingSystem,
    isSuspectedBot: isBot,
    botReason: isBot ? 'User agent matched automated client pattern' : '',
  }
}

function isRateLimited(key) {
  const now = Date.now()
  const windowMs = 60_000
  const maxRequests = 120
  const current = requestBuckets.get(key)

  if (!current || now - current.startedAt >= windowMs) {
    requestBuckets.set(key, { startedAt: now, count: 1 })
    return false
  }

  current.count += 1
  return current.count > maxRequests
}

function debugErrorPayload(error) {
  return {
    details: cleanText(error?.message, 1000),
    code: cleanText(error?.code, 120),
    hint: cleanText(error?.hint, 500),
  }
}

export async function trackAnonymousVisitor(req, res) {
  const debugEnabled = req.body?.debug === true

  try {
    const visitorId = cleanText(req.body?.visitor_id, 160)
    const sessionId = cleanText(req.body?.session_id, 160)

    if (!/^[A-Za-z0-9._:-]{8,160}$/.test(visitorId) || !/^[A-Za-z0-9._:-]{8,160}$/.test(sessionId)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid visitor or session ID',
      })
    }

    const ipAddress = getClientIp(req)

    if (isRateLimited(ipAddress || visitorId)) {
      return res.status(429).json({
        ok: false,
        message: 'Too many tracking requests',
      })
    }

    const now = new Date().toISOString()
    const path = cleanText(req.body?.path || '/', 500) || '/'
    const referrer = cleanText(req.body?.referrer, 1000)
    const userAgent = cleanText(req.get('user-agent'), 1000)
    const countryCode = cleanText(req.headers['cf-ipcountry'], 8).toUpperCase()
    const cfRay = cleanText(req.headers['cf-ray'], 120)
    const device = getDeviceInfo(userAgent)

    const { data: existing, error: findError } = await supabase
      .from('anonymous_visitor_sessions')
      .select('id, page_views, referrer')
      .eq('visitor_id', visitorId)
      .eq('session_id', sessionId)
      .maybeSingle()

    if (findError) throw findError

    const values = {
      last_path: path,
      referrer: existing?.referrer || referrer,
      user_agent: userAgent,
      ip_address: ipAddress || null,
      device_type: device.deviceType,
      browser: device.browser,
      operating_system: device.operatingSystem,
      country_code: countryCode,
      cf_ray: cfRay,
      is_suspected_bot: device.isSuspectedBot,
      bot_reason: device.botReason,
      last_seen_at: now,
      updated_at: now,
    }

    if (existing) {
      const { error } = await supabase
        .from('anonymous_visitor_sessions')
        .update({
          ...values,
          page_views: Number(existing.page_views || 0) + 1,
        })
        .eq('id', existing.id)

      if (error) throw error
    } else {
      const { error } = await supabase
        .from('anonymous_visitor_sessions')
        .insert({
          visitor_id: visitorId,
          session_id: sessionId,
          first_path: path,
          page_views: 1,
          first_seen_at: now,
          created_at: now,
          ...values,
        })

      if (error) throw error
    }

    return res.status(200).json({
      ok: true,
      visitor_id: visitorId,
      session_id: sessionId,
    })
  } catch (error) {
    console.error('VISITOR TRACKING ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to track visitor',
      ...(debugEnabled ? debugErrorPayload(error) : {}),
    })
  }
}
