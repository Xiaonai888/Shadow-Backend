import { supabase } from '../config/supabase.js'

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

function getRequestCountry(req) {
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


export async function heartbeatReaderPresence(req, res) {
  try {
    const userId = String(
      req.user?.user_id || ''
    ).trim()
    const sessionId = cleanSessionId(
      req.body?.session_id
    )

    if (!userId || !sessionId) {
      return res.status(400).json({
        ok: false,
        message:
          'user_id and session_id are required',
      })
    }

    const currentPath = cleanPath(
      req.body?.current_path
    )
    const visibilityState =
      cleanVisibilityState(
        req.body?.visibility_state
      )
    const isActive =
      req.body?.is_active !== false
    const userAgent = String(
      req.headers['user-agent'] || ''
    ).slice(0, 1000)

    const { countryCode, countryName } = getRequestCountry(req)

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
      message:
        'Failed to update reader presence',
      error: error.message,
    })
  }
}
