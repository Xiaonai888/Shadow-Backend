import { supabase } from '../config/supabase.js'

const EVENT_TABLE = 'rewarded_ad_events'
const EVENT_RATE_WINDOW_MS = 60 * 1000
const EVENT_RATE_LIMIT = 30
const DEFAULT_ANALYTICS_DAYS = 7
const MAX_ANALYTICS_DAYS = 31

const ALLOWED_EVENTS = new Set([
  'started',
  'ready',
  'cancelled',
  'no_fill',
  'error',
  'daily_limit_reached',
])

function clampAnalyticsDays(value) {
  const parsed = Number(value)

  if (!Number.isFinite(parsed)) {
    return DEFAULT_ANALYTICS_DAYS
  }

  return Math.min(
    MAX_ANALYTICS_DAYS,
    Math.max(1, Math.floor(parsed))
  )
}

function cleanErrorCode(value) {
  return String(value || '')
    .trim()
    .slice(0, 80)
}

async function isEventRateLimited(userId) {
  const since = new Date(
    Date.now() - EVENT_RATE_WINDOW_MS
  ).toISOString()

  const { count, error } = await supabase
    .from(EVENT_TABLE)
    .select('id', {
      count: 'exact',
      head: true,
    })
    .eq('user_id', String(userId))
    .gte('created_at', since)

  if (error) throw error

  return Number(count || 0) >=
    EVENT_RATE_LIMIT
}

export async function trackRewardedAdEvent(
  req,
  res
) {
  try {
    const userId = req.user?.user_id
    const { storyId, episodeId } =
      req.params
    const eventType = String(
      req.body?.eventType || ''
    ).trim()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Login required',
      })
    }

    if (!ALLOWED_EVENTS.has(eventType)) {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_REWARDED_AD_EVENT',
        message: 'Invalid rewarded ad event',
      })
    }

    if (
      await isEventRateLimited(userId)
    ) {
      return res.status(202).json({
        ok: true,
        ignored: true,
      })
    }

    const { error } = await supabase
      .from(EVENT_TABLE)
      .insert({
        user_id: String(userId),
        story_id: String(storyId),
        episode_id: String(episodeId),
        event_type: eventType,
        error_code:
          eventType === 'error'
            ? cleanErrorCode(
                req.body?.errorCode
              ) || null
            : null,
      })

    if (error) throw error

    return res.status(201).json({
      ok: true,
    })
  } catch (error) {
    console.error(
      'TRACK REWARDED AD EVENT ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to record rewarded ad event',
    })
  }
}

export async function getAdminRewardedAdAnalytics(
  req,
  res
) {
  try {
    const days = clampAnalyticsDays(
      req.query?.days
    )
    const since = new Date(
      Date.now() -
        days * 24 * 60 * 60 * 1000
    ).toISOString()

    const { data, error } =
      await supabase.rpc(
        'get_rewarded_ad_analytics',
        {
          p_since: since,
        }
      )

    if (error) throw error

    const row = Array.isArray(data)
      ? data[0] || {}
      : data || {}

    return res.json({
      ok: true,
      period: {
        days,
        since,
      },
      analytics: {
        started: Number(
          row.started || 0
        ),
        ready: Number(
          row.ready || 0
        ),
        cancelled: Number(
          row.cancelled || 0
        ),
        noFill: Number(
          row.no_fill || 0
        ),
        errors: Number(
          row.errors || 0
        ),
        dailyLimitReached: Number(
          row.daily_limit_reached || 0
        ),
        rewardGranted: Number(
          row.reward_granted || 0
        ),
        uniqueUsers: Number(
          row.unique_users || 0
        ),
      },
    })
  } catch (error) {
    console.error(
      'GET REWARDED AD ANALYTICS ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to load rewarded ad analytics',
    })
  }
}
