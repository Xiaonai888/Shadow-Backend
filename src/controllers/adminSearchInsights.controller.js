import { supabase } from '../config/supabase.js'

const ALLOWED_DAYS = new Set([7, 30, 90])

function getDays(value) {
  const parsed = Number.parseInt(value, 10)
  return ALLOWED_DAYS.has(parsed) ? parsed : 30
}

export async function getAdminSearchInsights(req, res) {
  try {
    const days = getDays(req.query.days)

    const { data, error } = await supabase.rpc(
      'get_search_analytics_admin',
      {
        p_days: days,
      }
    )

    if (error) throw error

    return res.status(200).json({
      ok: true,
      ...(data || {}),
    })
  } catch (error) {
    console.error('ADMIN SEARCH INSIGHTS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to load search insights',
    })
  }
}
