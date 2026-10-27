import { createHash } from 'node:crypto'
import { BlockList, isIP } from 'node:net'
import { supabase } from '../config/supabase.js'

const GEO_CACHE_TTL_MS = 12 * 60 * 60 * 1000
const GEO_FAILURE_TTL_MS = 10 * 60 * 1000
const GEO_CACHE_MAX = 5000
const GEO_TIMEOUT_MS = 2500
const COUNTRY_CACHE_MAX = 10000
const COUNTRY_RETRY_MS = 60 * 60 * 1000
const geoCache = new Map()
const geoInFlight = new Map()
const countryInitialized = new Map()
const countryInFlight = new Map()
const INVALID_COUNTRIES = new Set(['XX', 'ZZ', 'T1'])
const CF_SUBNETS = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22',
  '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22',
  '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32',
  '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29',
  '2c0f:f248::/32',
]
const cloudflarePeers = new BlockList()
for (const subnet of CF_SUBNETS) {
  const [address, length] = subnet.split('/')
  cloudflarePeers.addSubnet(address, Number(length), isIP(address) === 6 ? 'ipv6' : 'ipv4')
}

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

function cleanCountryCode(value) {
  const code = String(value || '').trim().toUpperCase()
  return /^[A-Z]{2}$/.test(code) && !INVALID_COUNTRIES.has(code) ? code : ''
}

function countryNameFromCode(value) {
  const code = cleanCountryCode(value)
  if (!code) return ''

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

function getVerifiedPeerIp(req) {
  const direct = normalizeIp(req.socket?.remoteAddress)
  return isPublicIp(direct) ? direct : ''
}

function isVerifiedCloudflarePeer(peerIp) {
  const type = isIP(peerIp)
  return type > 0 && cloudflarePeers.check(peerIp, type === 6 ? 'ipv6' : 'ipv4')
}

function getHeaderCountry(req, verifiedCloudflare) {
  if (!verifiedCloudflare) return { countryCode: '', countryName: '' }
  const raw = req.headers['cf-ipcountry'] || ''
  const countryCode = cleanCountryCode(Array.isArray(raw) ? raw[0] : raw)
  return {
    countryCode,
    countryName: countryCode ? countryNameFromCode(countryCode) : '',
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

async function fetchCountryByIp(ip) {
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
    const countryCode = cleanCountryCode(data?.country_code)

    if (data?.success === false || !countryCode) {
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

async function lookupCountryByIp(ip) {
  if (!ip || !isPublicIp(ip)) {
    return { countryCode: '', countryName: '' }
  }

  const cached = readGeoCache(ip)
  if (cached) return cached

  const key = getGeoCacheKey(ip)
  const existing = geoInFlight.get(key)
  if (existing) return existing

  const pending = fetchCountryByIp(ip)
  geoInFlight.set(key, pending)

  try {
    return await pending
  } finally {
    if (geoInFlight.get(key) === pending) geoInFlight.delete(key)
  }
}

function getRenderIngressIp(req) {
  const raw = req.headers['x-forwarded-for']
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string' || value.length > 2048) return ''
  const lastHop = normalizeIp(value.slice(value.lastIndexOf(',') + 1))
  return isPublicIp(lastHop) ? lastHop : ''
}

async function getRequestCountry(req) {
  const onRender = process.env.RENDER === 'true'
  const ingressIp = onRender ? getRenderIngressIp(req) : getVerifiedPeerIp(req)
  if (!ingressIp) return { countryCode: '', countryName: '', source: '' }

  const cloudflare = isVerifiedCloudflarePeer(ingressIp)
  const raw = cloudflare ? req.headers['cf-connecting-ip'] : null
  const forwardedClient = normalizeIp(Array.isArray(raw) ? raw[0] : raw)
  const clientIp = isPublicIp(forwardedClient) ? forwardedClient : ''
  if (cloudflare && !clientIp) return { countryCode: '', countryName: '', source: '' }

  const headerCountry = getHeaderCountry(req, cloudflare)
  if (headerCountry.countryCode) {
    return { ...headerCountry, source: 'cloudflare' }
  }

  const lookupIp = clientIp || ingressIp
  const resolved = await lookupCountryByIp(lookupIp)
  return { ...resolved, source: 'admin_ip_lookup' }
}

function rememberCountryStatus(userId, status) {
  countryInitialized.delete(userId)
  countryInitialized.set(userId, status)
  if (countryInitialized.size > COUNTRY_CACHE_MAX) {
    countryInitialized.delete(countryInitialized.keys().next().value)
  }
}

async function initializeSavedCountry(req, userId) {
  const cached = countryInitialized.get(userId)
  if (cached && (cached.done || cached.nextAttempt > Date.now())) return cached

  const pending = countryInFlight.get(userId)
  if (pending) return pending

  const task = (async () => {
    const retryStatus = { done: false, nextAttempt: Date.now() + COUNTRY_RETRY_MS, syncPresence: false }
    try {
      const { data: saved, error: savedError } = await supabase
        .from('shadow_reader_classifications')
        .select('detected_country,admin_country_override')
        .eq('user_id', userId)
        .maybeSingle()

      if (savedError) throw savedError
      if (cleanCountryCode(saved?.detected_country)) {
        const result = { done: true, nextAttempt: 0, syncPresence: false }
        rememberCountryStatus(userId, result)
        return result
      }

      const { data: presence, error: presenceError } = await supabase
        .from('reader_presence')
        .select('first_country_code,last_country_code,first_country_name,last_country_name')
        .eq('user_id', userId)
        .maybeSingle()

      if (presenceError) throw presenceError

      let countryCode = cleanCountryCode(presence?.last_country_code) || cleanCountryCode(presence?.first_country_code)
      let countryName = countryCode
        ? String(presence?.last_country_name || presence?.first_country_name || countryNameFromCode(countryCode)).slice(0, 120)
        : ''
      let source = 'admin_reader_presence'

      if (!countryCode) {
        const resolved = await getRequestCountry(req)
        countryCode = cleanCountryCode(resolved.countryCode)
        countryName = resolved.countryName
        source = resolved.source || 'admin_ip_lookup'
      }

      if (!countryCode) {
        rememberCountryStatus(userId, retryStatus)
        return retryStatus
      }

      const { data: storedCode, error: writeError } = await supabase.rpc('save_shadow_reader_country_once', {
        p_user_id: userId,
        p_country_code: countryCode,
        p_source: source,
      })
      if (writeError) throw writeError
      const actualCode = cleanCountryCode(storedCode)
      if (!actualCode) throw new Error('Country was not saved')

      const result = {
        done: true,
        nextAttempt: 0,
        syncPresence: true,
        countryCode: actualCode,
        countryName: actualCode === countryCode ? countryName : countryNameFromCode(actualCode),
      }
      rememberCountryStatus(userId, result)
      return result
    } catch (error) {
      console.warn('READER COUNTRY INITIALIZATION:', String(error?.message || error))
      rememberCountryStatus(userId, retryStatus)
      return retryStatus
    }
  })()

  countryInFlight.set(userId, task)
  try {
    return await task
  } finally {
    if (countryInFlight.get(userId) === task) countryInFlight.delete(userId)
  }
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
    const status = await initializeSavedCountry(req, userId)
    const syncCode = status.syncPresence ? status.countryCode : ''
    if (syncCode) status.syncPresence = false

    const { error } = syncCode
      ? await supabase.rpc('touch_reader_presence_with_country', {
        p_user_id: userId,
        p_session_id: sessionId,
        p_current_path: currentPath,
        p_visibility_state: visibilityState,
        p_is_active: isActive,
        p_user_agent: userAgent,
        p_country_code: syncCode,
        p_country_name: status.countryName || countryNameFromCode(syncCode),
      })
      : await supabase.rpc('upsert_reader_presence_heartbeat', {
        p_user_id: userId,
        p_session_id: sessionId,
        p_current_path: currentPath,
        p_visibility_state: visibilityState,
        p_is_active: isActive,
        p_user_agent: userAgent,
      })

    if (error) {
      if (syncCode) status.syncPresence = true
      throw error
    }

    return res.status(200).json({ ok: true })
  } catch (error) {
    console.error('READER PRESENCE HEARTBEAT ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to update reader presence',
      error: error.message,
    })
  }
}
