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

    const { error } = await supabase.rpc(
      'upsert_reader_presence_heartbeat',
      {
        p_user_id: userId,
        p_session_id: sessionId,
        p_current_path: currentPath,
        p_visibility_state:
          visibilityState,
        p_is_active: isActive,
        p_user_agent: userAgent,
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
