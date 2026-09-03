import { supabase } from '../config/supabase.js'
import { serveAuthorCachedJson } from '../services/authorRequestCache.service.js'

function getUserId(req) {
  return String(
    req.user?.user_id ||
      req.user?.id ||
      ''
  ).trim()
}

async function getMyAuthorDashboardBadgesUncached(
  req,
  res
) {
  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      })
    }

    const { data, error } =
      await supabase.rpc(
        'get_author_dashboard_badges',
        {
          p_user_id: userId,
        }
      )

    if (error) throw error

    const row = Array.isArray(data)
      ? data[0] || {}
      : data || {}

    res.set(
      'Cache-Control',
      'private, no-store'
    )

    return res.status(200).json({
      ok: true,
      story_unread_count: Number(
        row.story_unread_count || 0
      ),
      mail_unread_count: Number(
        row.mail_unread_count || 0
      ),
    })
  } catch (error) {
    console.error(
      'GET AUTHOR DASHBOARD BADGES ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to load dashboard badges',
      error: error.message,
    })
  }
}


export async function getMyAuthorDashboardBadges(
  req,
  res
) {
  return serveAuthorCachedJson({
    req,
    res,
    namespace: 'author-dashboard-badges',
    ttlMs: 30 * 1000,
    handler: getMyAuthorDashboardBadgesUncached,
  })
}
