import { getActiveReaderToken } from '../utils/readerActiveAccount'

const API_BASE_URL = import.meta.env.VITE_API_URL ||
  (['localhost', '127.0.0.1'].includes(window.location.hostname)
    ? 'http://localhost:5000'
    : 'https://shadow-backend-kucw.onrender.com')

const VIEWER_STORAGE_KEY = 'shadow_fast_reel_viewer_id_v1'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const recentlyReported = new Map()
const REPEAT_INTERVAL_MS = 30 * 60 * 1000
let volatileViewerId = null

export class FastReelViewError extends Error {
  constructor(status, code, message, reason = '') {
    super(message)
    this.name = 'FastReelViewError'
    this.status = status
    this.code = code
    this.reason = reason
    this.retryable = code === 'INVALID_VIEW_RESPONSE' || status === 0 || status === 408 || status === 429 || status >= 500
  }
}

function getBrowserViewerId() {
  try {
    const prior = localStorage.getItem(VIEWER_STORAGE_KEY)
    if (prior && UUID.test(prior)) return prior
  } catch {}

  if (volatileViewerId) return volatileViewerId
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') return null

  const value = crypto.randomUUID()
  volatileViewerId = value
  try { localStorage.setItem(VIEWER_STORAGE_KEY, value) } catch {}
  return value
}

export async function recordFastReelView(videoId) {
  const id = String(videoId || '').trim()
  if (!UUID.test(id)) return null

  const now = Date.now()
  const last = recentlyReported.get(id)
  if (last && now - last < REPEAT_INTERVAL_MS) return null

  const viewerId = getBrowserViewerId()
  if (!viewerId) return null

  recentlyReported.set(id, now)
  if (recentlyReported.size > 500) recentlyReported.clear()

  try {
    const response = await fetch(
      `${API_BASE_URL}/api/fast/videos/${encodeURIComponent(id)}/view`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewer_id: viewerId }),
        cache: 'no-store',
        keepalive: true,
      }
    )
    const data = await response.json().catch(() => ({}))
    if (!response.ok || !data.ok) throw new Error(data.message || 'View tracking failed')
    return data
  } catch (error) {
    recentlyReported.delete(id)
    throw error
  }
}

export async function recordFastReelViewV2(
  videoId,
  { mode = 'fast', watchedSeconds = 0, durationSeconds = null } = {}
) {
  const id = String(videoId || '').trim()
  if (!UUID.test(id)) {
    throw new FastReelViewError(400, 'INVALID_REEL_ID', 'Invalid Reel ID')
  }
  if (mode !== 'fast' && mode !== 'qualified') {
    throw new FastReelViewError(400, 'INVALID_VIEW_MODE', 'Invalid Reel view mode')
  }

  const body = { mode }
  if (mode === 'qualified') {
    if (
      typeof watchedSeconds !== 'number' ||
      typeof durationSeconds !== 'number' ||
      !Number.isFinite(watchedSeconds) ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0 ||
      durationSeconds > 43200 ||
      watchedSeconds < 0 ||
      watchedSeconds > durationSeconds + 1
    ) {
      throw new FastReelViewError(400, 'INVALID_WATCH_DATA', 'Invalid Reel playback duration')
    }
    body.watched_seconds = watchedSeconds
    body.video_duration_seconds = durationSeconds
  }

  const token = getActiveReaderToken()
  if (!token) {
    throw new FastReelViewError(401, 'LOGIN_REQUIRED', 'Reader login required to count Reel views')
  }

  let response
  try {
    response = await fetch(
      `${API_BASE_URL}/api/fast/videos/${encodeURIComponent(id)}/view/v2`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        cache: 'no-store',
      }
    )
  } catch (error) {
    throw new FastReelViewError(0, 'VIEW_NETWORK_ERROR', error?.message || 'Reel view request failed')
  }

  const data = await response.json().catch(() => null)
  if (!response.ok || data?.ok !== true) {
    throw new FastReelViewError(
      response.status,
      String(data?.code || 'VIEW_REQUEST_FAILED'),
      String(data?.message || 'Unable to record Reel playback'),
      String(data?.reason || '')
    )
  }

  if (
    typeof data.counted !== 'boolean' ||
    !['number', 'string'].includes(typeof data.view_count) ||
    !Number.isSafeInteger(Number(data.view_count)) ||
    Number(data.view_count) < 0
  ) {
    throw new FastReelViewError(response.status, 'INVALID_VIEW_RESPONSE', 'Invalid Reel view response')
  }

  return data
}
