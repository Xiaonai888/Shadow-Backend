import { createHmac } from 'node:crypto'
import { supabase } from '../config/supabase.js'
import { markRequestDiagnostic } from '../services/trafficDiagnostic.service.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VIEW_WINDOW_MS = 5 * 60 * 1000
const VIEW_SAMPLE_LIMIT = 12
const VIEW_BUCKET_LIMIT = 24
const EXPECTED_VIEW_REASONS = new Set([
  'fast_cooldown',
  'qualified_view_required',
  'qualified_cooldown',
  'watch_time_pending',
  'qualification_session_required',
  'fast_view_available',
  'reel_unavailable',
  'invalid_watch_data',
])

function newViewWindow(now) {
  return {
    startedAt: now,
    requests: 0,
    counted: 0,
    notCounted: 0,
    errors: 0,
    slow: 0,
    durationMs: 0,
    sampled: 0,
    suppressed: 0,
    statuses: new Map(),
    reasons: new Map(),
    sampledSignatures: new Set(),
  }
}

let viewWindow = newViewWindow(Date.now())

function safeReason(value) {
  const reason = String(value || 'unknown').trim().slice(0, 64)
  return /^[a-zA-Z0-9_-]{1,64}$/.test(reason) ? reason : 'unknown'
}

function incrementBucket(map, value) {
  const key = safeReason(value)
  if (!map.has(key) && map.size >= VIEW_BUCKET_LIMIT) {
    map.set('other', (map.get('other') || 0) + 1)
    return
  }
  map.set(key, (map.get(key) || 0) + 1)
}

function observeReelView({ startedAt, status, payload, mode, stage, rpcCode = '' }) {
  const now = Date.now()
  if (now - viewWindow.startedAt >= VIEW_WINDOW_MS) {
    if (viewWindow.requests) {
      console.info('FAST_REEL_VIEW_V2_SUMMARY', JSON.stringify({
        from: new Date(viewWindow.startedAt).toISOString(),
        to: new Date(now).toISOString(),
        requests: viewWindow.requests,
        counted: viewWindow.counted,
        not_counted: viewWindow.notCounted,
        errors: viewWindow.errors,
        slow: viewWindow.slow,
        avg_ms: Math.round(viewWindow.durationMs / viewWindow.requests),
        statuses: Object.fromEntries(viewWindow.statuses),
        reasons: Object.fromEntries(viewWindow.reasons),
        sampled_issues: viewWindow.sampled,
        suppressed_issues: viewWindow.suppressed,
      }))
    }
    viewWindow = newViewWindow(now)
  }

  const counted = status >= 200 && status < 300 && payload?.counted === true
  const reason = safeReason(payload?.reason || payload?.code || (counted ? 'counted' : `http_${status}`))
  const elapsed = Math.max(0, now - startedAt)
  const failed = status >= 400 || payload?.ok === false
  const slow = elapsed >= 2000

  viewWindow.requests += 1
  viewWindow.durationMs += elapsed
  if (counted) viewWindow.counted += 1
  else viewWindow.notCounted += 1
  if (failed) viewWindow.errors += 1
  if (slow) viewWindow.slow += 1
  incrementBucket(viewWindow.statuses, String(status))
  incrementBucket(viewWindow.reasons, `${mode}_${reason}`)

  markRequestDiagnostic({
    feature: 'fast_reel_view_v2',
    stage,
    view_mode: mode,
    view_result: reason,
    view_counted: counted,
    view_http_status: status,
    view_duration_ms: elapsed,
    error_code: rpcCode || payload?.code || (status >= 500 ? 'FAST_REEL_VIEW_HTTP_5XX' : 'none'),
  })

  const unexpected = status >= 400 || slow || (!counted && !EXPECTED_VIEW_REASONS.has(reason))
  if (!unexpected) return

  const signature = `${mode}:${status}:${reason}:${safeReason(rpcCode)}`
  if (viewWindow.sampledSignatures.has(signature)) return
  if (viewWindow.sampled >= VIEW_SAMPLE_LIMIT) {
    viewWindow.suppressed += 1
    return
  }

  viewWindow.sampledSignatures.add(signature)
  viewWindow.sampled += 1
  console.warn('FAST_REEL_VIEW_V2_ISSUE', JSON.stringify({
    mode,
    stage,
    status,
    reason,
    rpc_code: safeReason(rpcCode) === 'unknown' ? null : safeReason(rpcCode),
    duration_ms: elapsed,
  }))
}

export async function recordFastReelView(req, res) {
  const videoId = String(req.params.id || '').trim()
  const viewerId = req.body?.viewer_id

  if (!UUID.test(videoId) || typeof viewerId !== 'string' || !UUID.test(viewerId)) {
    return res.status(400).json({ ok: false, message: 'Invalid Reel view request.' })
  }

  const secret = process.env.FAST_REEL_VIEW_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) {
    console.error('[FAST_REEL_VIEW_SECRET_MISSING]')
    return res.status(503).json({ ok: false, message: 'Reel view tracking unavailable.' })
  }

  try {
    const viewerHash = createHmac('sha256', secret)
      .update(`fast-reel-v1:browser:${viewerId.toLowerCase()}`)
      .digest('hex')
    const { data, error } = await supabase.rpc('record_fast_reel_play', {
      p_video_id: videoId,
      p_viewer_hash: viewerHash,
    })
    if (error) throw error

    const result = Array.isArray(data) ? data[0] : data
    res.set('Cache-Control', 'private, no-store')
    if (!result || result.total_views === null || result.total_views === undefined) {
      return res.status(404).json({ ok: false, message: 'Published Reel not found.' })
    }
    return res.json({
      ok: true,
      counted: Boolean(result.counted),
      view_count: Number(result.total_views),
    })
  } catch (error) {
    console.error('[FAST_REEL_VIEW_COUNT_ERROR]', { code: error?.code, message: error?.message })
    return res.status(500).json({ ok: false, message: 'Unable to record Reel playback.' })
  }
}

async function diagnoseReelViewEligibility(videoId, readerId) {
  const { data, error } = await supabase
    .from('fast_videos')
    .select('id,user_id,status,access_type,platform,view_count')
    .eq('id', videoId)
    .maybeSingle()

  if (error) {
    return {
      status: 503,
      code: 'REEL_VIEW_ELIGIBILITY_CHECK_FAILED',
      message: 'Could not check Reel eligibility after the view was rejected.',
      diagnostic: 'eligibility_read_failed',
      dbCode: safeReason(error.code),
    }
  }

  if (!data) {
    return {
      status: 404,
      code: 'REEL_NOT_FOUND',
      message: 'This Reel is not present in the view database.',
      diagnostic: 'video_missing',
    }
  }

  const reasons = []
  if (data.status !== 'published') reasons.push('not_published')
  if (data.access_type !== 'free') reasons.push('not_free')
  if (data.platform !== 'youtube') reasons.push('not_youtube')

  if (reasons.length) {
    const isOwner = String(data.user_id) === String(readerId)
    const first = reasons[0]
    const ownerDetails = {
      not_published: ['REEL_NOT_PUBLISHED', 'Publish this Reel before public views can be counted.'],
      not_free: ['REEL_NOT_FREE', 'Only free Reels can receive public views.'],
      not_youtube: ['REEL_PLATFORM_NOT_YOUTUBE', 'This Reel must be published using a YouTube link.'],
    }
    const [code, message] = isOwner
      ? ownerDetails[first]
      : ['REEL_NOT_ELIGIBLE', 'This Reel is not available for public view counting.']
    return {
      status: 404,
      code,
      message,
      diagnostic: reasons.join('_'),
      publicReason: isOwner ? reasons.join('_') : 'not_eligible',
    }
  }

  if (data.view_count == null || !Number.isSafeInteger(Number(data.view_count)) || Number(data.view_count) < 0) {
    return {
      status: 502,
      code: 'REEL_VIEW_COUNTER_INVALID',
      message: 'Reel exists but its stored view counter is invalid.',
      diagnostic: 'counter_invalid',
    }
  }

  return {
    status: 502,
    code: 'REEL_VIEW_RPC_RESULT_MISMATCH',
    message: 'Reel is eligible, but the SQL view function did not return its view counter.',
    diagnostic: 'rpc_missing_total',
  }
}

export async function recordFastReelViewV2(req, res) {
  res.set('Cache-Control', 'private, no-store')
  const startedAt = Date.now()
  const userId = req.user?.user_id
  const videoId = String(req.params.id || '').trim()
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body : {}
  const mode = body.mode === 'qualified' ? 'qualified' : body.mode === 'fast' ? 'fast' : 'invalid'
  const finish = (status, payload, stage, rpcCode = '') => {
    observeReelView({ startedAt, status, payload, mode, stage, rpcCode })
    return res.status(status).json(payload)
  }

  if (!userId || !UUID.test(String(userId))) {
    return finish(401, {
      ok: false,
      code: 'READER_LOGIN_REQUIRED',
      message: 'Reader login required to count Reel views.',
    }, 'validate_reader')
  }
  if (!UUID.test(videoId) || mode === 'invalid') {
    return finish(400, {
      ok: false,
      code: 'INVALID_REEL_VIEW_REQUEST',
      message: 'Invalid Reel view request.',
    }, 'validate_request')
  }

  let watchedSeconds = 0
  let durationSeconds = null
  if (mode === 'qualified') {
    watchedSeconds = body.watched_seconds
    durationSeconds = body.video_duration_seconds
    if (
      typeof watchedSeconds !== 'number' || !Number.isFinite(watchedSeconds) ||
      typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) ||
      watchedSeconds < 0 || durationSeconds <= 0 || durationSeconds > 43200 ||
      watchedSeconds > durationSeconds + 1
    ) {
      return finish(400, {
        ok: false,
        code: 'INVALID_REEL_WATCH_DATA',
        message: 'Valid playback duration and watched seconds are required.',
      }, 'validate_watch')
    }
  }

  try {
    const { data, error } = await supabase.rpc('record_fast_reel_play_v2', {
      p_user_id: userId,
      p_video_id: videoId,
      p_mode: mode,
      p_watched_seconds: watchedSeconds,
      p_video_duration_seconds: durationSeconds,
    })
    if (error) throw error

    const result = Array.isArray(data) ? data[0] : data
    if (!result || result.total_views == null) {
      const check = await diagnoseReelViewEligibility(videoId, userId)
      console.warn('FAST_REEL_VIEW_ELIGIBILITY_DIAG', JSON.stringify({
        video_id: videoId,
        mode,
        stage: check.diagnostic,
        code: check.code,
        db_code: check.dbCode || null,
      }))
      return finish(check.status, {
        ok: false,
        code: check.code,
        reason: check.publicReason || check.diagnostic,
        message: check.message,
      }, 'eligibility_check', check.dbCode || '')
    }

    const total = Number(result.total_views)
    if (!Number.isSafeInteger(total) || total < 0) {
      throw Object.assign(new Error('Invalid total_views returned by view RPC'), {
        code: 'INVALID_VIEW_TOTAL',
      })
    }

    return finish(200, {
      ok: true,
      counted: result.counted === true,
      view_count: total,
      reason: String(result.reason || ''),
      fast_used: Number(result.fast_used || 0),
      fast_remaining: Number(result.fast_remaining || 0),
      requires_qualified_view: result.requires_qualified_view === true,
    }, 'rpc_result')
  } catch (error) {
    const rpcCode = String(error?.code || 'UNKNOWN_RPC_ERROR').slice(0, 64)
    const migrationMissing = ['PGRST202', '42883', '42501'].includes(rpcCode)
    return finish(migrationMissing ? 503 : 500, {
      ok: false,
      code: migrationMissing ? 'REEL_VIEW_RPC_UNAVAILABLE' : 'REEL_VIEW_RPC_FAILED',
      message: migrationMissing ? 'Reel view V2 is not available yet.' : 'Unable to record Reel playback.',
    }, 'rpc_error', rpcCode)
  }
}
