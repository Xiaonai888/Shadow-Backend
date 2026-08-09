import { supabase } from '../config/supabase.js'

const SESSION_RESET_MS = 10 * 60 * 1000

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

function shouldResetSession(existing, sessionId, nowMs) {
  if (!existing) return true
  if (String(existing.session_id || '') !== sessionId) return true

  const lastSeenMs = new Date(existing.last_seen_at || 0).getTime()
  if (!Number.isFinite(lastSeenMs)) return true

  return nowMs - lastSeenMs > SESSION_RESET_MS
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
    const now = new Date()
    const nowIso = now.toISOString()

    const { data: existing, error: existingError } = await supabase
      .from('reader_presence')
      .select('user_id, session_id, session_started_at, last_seen_at, last_activity_at')
      .eq('user_id', userId)
      .maybeSingle()

    if (existingError) throw existingError

    const resetSession = shouldResetSession(existing, sessionId, now.getTime())
    const sessionStartedAt = resetSession
      ? nowIso
      : existing?.session_started_at || nowIso

    const lastActivityAt = isActive
      ? nowIso
      : existing?.last_activity_at || nowIso

    const { data: presence, error } = await supabase
      .from('reader_presence')
      .upsert(
        {
          user_id: userId,
          session_id: sessionId,
          session_started_at: sessionStartedAt,
          last_seen_at: nowIso,
          last_activity_at: lastActivityAt,
          current_path: currentPath,
          visibility_state: visibilityState,
          user_agent: userAgent,
          updated_at: nowIso,
        },
        {
          onConflict: 'user_id',
        }
      )
      .select(
        'user_id, session_id, session_started_at, last_seen_at, last_activity_at, current_path, visibility_state'
      )
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      presence,
    })
  } catch (error) {
    console.error('READER PRESENCE HEARTBEAT ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to update reader presence',
      error: error.message,
    })
  }
}
