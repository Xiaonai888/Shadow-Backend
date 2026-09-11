import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { supabase } from '../config/supabase.js'

const GEO_CACHE_TTL_MS = 12 * 60 * 60 * 1000
const GEO_FAILURE_TTL_MS = 10 * 60 * 1000
const GEO_CACHE_MAX = 5000
const GEO_TIMEOUT_MS = 2500
const geoCache = new Map()

function cleanSessionId(value) {
  return String(value || '').trim().slice(0, 120)
}

function cleanPath(value) {
  const raw = String(value || '/').trim().slice(0, 500)
  const path = raw.split(/[?#]/)[0] || '/'

  return path.startsWith('/') ? path : `/${path}`
}

function cleanVisibilityState(value) {
  return String(value || '').toLowerCase() === 'hidden'
    ? 'hidden'
    : 'visible'
}

function countryNameFromCode(value) {
  const code = String(value || '').trim().slice(0, 2).toUpperCase()

  if (!/^[A-Z]{2}$/.test(code) || code === 'XX') return ''

  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code
  } catch {
    return code
  }
}

function normalizeIp(value) {
  let ip = String(value || '').trim()

  if (!ip) return ''

  if (ip.includes(',')) {
    ip = ip.split(',')[0].trim()
  }

  if (ip.startsWith('::ffff:')) {
    ip = ip.slice(7)
  }

  if (ip.startsWith('[') && ip.includes(']')) {
    ip = ip.slice(1, ip.indexOf(']'))
  }

  return isIP(ip) ? ip : ''
}

function isPublicIp(value) {
  const ip = normalizeIp(value)
  const version = isIP(ip)

  if (!version) return false

  if (version === 4) {
    const parts = ip.split('.').map(Number)
    const [a, b] = parts

    if (a === 0 || a === 10 || a === 127) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 100 && b >= 64 && b <= 127) return false
    if (a >= 224) return false

    return true
  }

  const lower = ip.toLowerCase()

  if (lower === '::' || lower === '::1') return false
  if (lower.startsWith('fc') || lower.startsWith('fd')) return false
  if (/^fe[89ab]/.test(lower)) return false

  return true
}

function getClientIp(req) {
  const candidates = [
    req.headers['cf-connecting-ip'],
    req.headers['x-forwarded-for'],
    req.headers['x-real-ip'],
    req.ip,
    req.socket?.remoteAddress,
  ]

  for (const candidate of candidates) {
    const raw = Array.isArray(candidate) ? candidate[0] : candidate
    const ip = normalizeIp(raw)

    if (ip && isPublicIp(ip)) return ip
  }

  return ''
}

function getHeaderCountry(req) {
  const raw =
    req.headers['cf-ipcountry'] ||
    req.headers['x-vercel-ip-country'] ||
    req.headers['x-country-code'] ||
    req.headers['cloudfront-viewer-country'] ||
    ''

  const countryCode = String(Array.isArray(raw) ? raw[0] : raw)
    .trim()
    .slice(0, 2)
    .toUpperCase()

  if (!/^[A-Z]{2}$/.test(countryCode) || countryCode === 'XX') {
    return { countryCode: '', countryName: '' }
  }

  return {
    countryCode,
    countryName: countryNameFromCode(countryCode),
  }
}

function getGeoCacheKey(ip) {
  return createHash('sha256').update(ip).digest('hex')
}

function readGeoCache(ip) {
  const key = getGeoCacheKey(ip)
  const cached = geoCache.get(key)

  if (!cached) return null

  if (cached.expiresAt <= Date.now()) {
    geoCache.delete(key)
    return null
  }

  return cached.value
}

function writeGeoCache(ip, value, ttl) {
  if (geoCache.size >= GEO_CACHE_MAX) {
    geoCache.clear()
  }

  geoCache.set(getGeoCacheKey(ip), {
    value,
    expiresAt: Date.now() + ttl,
  })
}

async function lookupCountryByIp(ip) {
  if (!ip || !isPublicIp(ip)) {
    return { countryCode: '', countryName: '' }
  }

  const cached = readGeoCache(ip)

  if (cached) return cached

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), GEO_TIMEOUT_MS)

  try {
    const response = await fetch(
      `https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country_code,country`,
      {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'ShadowReaderCountry/1.0',
        },
      }
    )

    if (!response.ok) {
      throw new Error(`Geo lookup failed (${response.status})`)
    }

    const data = await response.json()
    const countryCode = String(data?.country_code || '')
      .trim()
      .slice(0, 2)
      .toUpperCase()

    if (
      data?.success === false ||
      !/^[A-Z]{2}$/.test(countryCode) ||
      countryCode === 'XX'
    ) {
      const empty = { countryCode: '', countryName: '' }
      writeGeoCache(ip, empty, GEO_FAILURE_TTL_MS)
      return empty
    }

    const result = {
      countryCode,
      countryName:
        String(data?.country || '').trim().slice(0, 120) ||
        countryNameFromCode(countryCode),
    }

    writeGeoCache(ip, result, GEO_CACHE_TTL_MS)
    return result
  } catch {
    const empty = { countryCode: '', countryName: '' }
    writeGeoCache(ip, empty, GEO_FAILURE_TTL_MS)
    return empty
  } finally {
    clearTimeout(timeout)
  }
}

async function getRequestCountry(req) {
  const headerCountry = getHeaderCountry(req)

  if (headerCountry.countryCode) {
    return headerCountry
  }

  const ip = getClientIp(req)

  if (!ip) {
    return { countryCode: '', countryName: '' }
  }

  return lookupCountryByIp(ip)
}

export async function heartbeatReaderPresence(req, res) {
  try {
    const userId = String(req.user?.user_id || '').trim()
    const sessionId = cleanSessionId(req.body?.session_id)

    if (!userId || !sessionId) {
      return res.status(400).json({
        ok: false,
        message: 'user_id and session_id are required',
      })
    }

    const currentPath = cleanPath(req.body?.current_path)
    const visibilityState = cleanVisibilityState(req.body?.visibility_state)
    const isActive = req.body?.is_active !== false
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 1000)

    const { countryCode, countryName } = await getRequestCountry(req)

    const { error } = await supabase.rpc(
      'touch_reader_presence_with_country',
      {
        p_user_id: userId,
        p_session_id: sessionId,
        p_current_path: currentPath,
        p_visibility_state: visibilityState,
        p_is_active: isActive,
        p_user_agent: userAgent,
        p_country_code: countryCode,
        p_country_name: countryName,
      }
    )

    if (error) throw error

    return res.status(200).json({
      ok: true,
    })
  } catch (error) {
    console.error(
      'READER PRESENCE HEARTBEAT ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message: 'Failed to update reader presence',
      error: error.message,
    })
  }
}
