import { isIP } from 'node:net'
import { supabase } from '../config/supabase.js'

const requestBuckets = new Map()

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength)
}

function clampNumber(value, min, max, fallback = 0) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
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
    isBot,
  }
}

function addSignal(signals, code, score, reason) {
  if (signals.some((item) => item.code === code)) return

  signals.push({
    code,
    score,
    reason,
  })
}

function calculateBotRisk({ userAgent, device, browserSignals, behaviorSignals }) {
  const signals = []
  let score = 0

  if (device.isBot) {
    addSignal(
      signals,
      'user_agent_pattern',
      55,
      'User agent matched a known automated client pattern'
    )
    score += 55
  }

  if (!userAgent) {
    addSignal(signals, 'missing_user_agent', 20, 'Request did not include a user agent')
    score += 20
  }

  if (browserSignals.webdriver_detected === true) {
    addSignal(
      signals,
      'webdriver_detected',
      35,
      'Browser reported navigator.webdriver as true'
    )
    score += 35
  }

  const navigationCount10s = clampNumber(
    behaviorSignals.navigation_count_10s,
    0,
    100,
    0
  )

  if (navigationCount10s >= 10) {
    addSignal(
      signals,
      'rapid_navigation_high',
      30,
      `${navigationCount10s} navigation events were observed within 10 seconds`
    )
    score += 30
  } else if (navigationCount10s >= 6) {
    addSignal(
      signals,
      'rapid_navigation_medium',
      18,
      `${navigationCount10s} navigation events were observed within 10 seconds`
    )
    score += 18
  }

  const rapidRepeatCount30s = clampNumber(
    behaviorSignals.rapid_repeat_count_30s,
    0,
    100,
    0
  )

  if (rapidRepeatCount30s >= 5) {
    addSignal(
      signals,
      'rapid_repeat_high',
      25,
      `The same path was repeated ${rapidRepeatCount30s} times within 30 seconds`
    )
    score += 25
  } else if (rapidRepeatCount30s >= 3) {
    addSignal(
      signals,
      'rapid_repeat_medium',
      15,
      `The same path was repeated ${rapidRepeatCount30s} times within 30 seconds`
    )
    score += 15
  }

  const screenWidth = clampNumber(browserSignals.screen_width, 0, 100000, 0)
  const screenHeight = clampNumber(browserSignals.screen_height, 0, 100000, 0)

  if (
    Object.keys(browserSignals).length > 0
    && (screenWidth < 100 || screenHeight < 100)
  ) {
    addSignal(
      signals,
      'invalid_screen_size',
      10,
      'Browser reported an unusually small or missing screen size'
    )
    score += 10
  }

  const languagesCount = clampNumber(browserSignals.languages_count, 0, 100, 0)

  if (
    Object.keys(browserSignals).length > 0
    && !cleanText(browserSignals.language, 40)
    && languagesCount === 0
  ) {
    addSignal(
      signals,
      'missing_language',
      5,
      'Browser did not report a language'
    )
    score += 5
  }

  score = Math.min(100, Math.max(0, score))

  let riskLevel = 'normal'
  if (score >= 85) riskLevel = 'high_risk'
  else if (score >= 70) riskLevel = 'likely_bot'
  else if (score >= 50) riskLevel = 'suspicious'
  else if (score >= 30) riskLevel = 'low_risk'

  return {
    score,
    riskLevel,
    signals,
    webdriverDetected: browserSignals.webdriver_detected === true,
    rapidRepeatCount: rapidRepeatCount30s,
  }
}

function mergeSignals(existingSignals, newSignals) {
  const merged = new Map()

  for (const signal of Array.isArray(existingSignals) ? existingSignals : []) {
    if (signal?.code) merged.set(signal.code, signal)
  }

  for (const signal of newSignals) {
    merged.set(signal.code, signal)
  }

  return Array.from(merged.values()).slice(0, 30)
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
    const browserSignals =
      req.body?.browser_signals && typeof req.body.browser_signals === 'object'
        ? req.body.browser_signals
        : {}
    const behaviorSignals =
      req.body?.behavior_signals && typeof req.body.behavior_signals === 'object'
        ? req.body.behavior_signals
        : {}

    const device = getDeviceInfo(userAgent)
    const currentRisk = calculateBotRisk({
      userAgent,
      device,
      browserSignals,
      behaviorSignals,
    })

    const { data: existing, error: findError } = await supabase
      .from('anonymous_visitor_sessions')
      .select(
        'id, page_views, referrer, bot_score, risk_level, bot_signals, webdriver_detected, event_count, rapid_repeat_count'
      )
      .eq('visitor_id', visitorId)
      .eq('session_id', sessionId)
      .maybeSingle()

    if (findError) throw findError

    const finalScore = Math.max(
      Number(existing?.bot_score || 0),
      currentRisk.score
    )
    const finalRisk =
      finalScore >= 85
        ? 'high_risk'
        : finalScore >= 70
          ? 'likely_bot'
          : finalScore >= 50
            ? 'suspicious'
            : finalScore >= 30
              ? 'low_risk'
              : 'normal'
    const finalSignals = mergeSignals(
      existing?.bot_signals,
      currentRisk.signals
    )
    const isSuspectedBot = finalScore >= 50
    const botReason = finalSignals
      .slice(0, 5)
      .map((signal) => signal.reason)
      .filter(Boolean)
      .join('; ')

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
      is_suspected_bot: isSuspectedBot,
      bot_reason: botReason,
      bot_score: finalScore,
      risk_level: finalRisk,
      bot_signals: finalSignals,
      webdriver_detected:
        Boolean(existing?.webdriver_detected)
        || currentRisk.webdriverDetected,
      event_count: Number(existing?.event_count || 0) + 1,
      rapid_repeat_count: Math.max(
        Number(existing?.rapid_repeat_count || 0),
        currentRisk.rapidRepeatCount
      ),
      last_event_at: now,
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
      bot_score: finalScore,
      risk_level: finalRisk,
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
