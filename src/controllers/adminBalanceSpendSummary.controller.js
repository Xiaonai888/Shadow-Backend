import { supabase } from '../config/supabase.js'

function toPositiveInt(value, fallback, max) {
  const number = Number.parseInt(String(value || ''), 10)

  if (!Number.isFinite(number) || number < 1) {
    return fallback
  }

  return Math.min(number, max)
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '').trim()
  )
}

export async function getAdminBalanceSpendSummary(req, res) {
  try {
    const userId = String(req.params.userId || '').trim()

    if (!isUuid(userId)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid reader ID',
      })
    }

    const limit = toPositiveInt(req.query.limit, 10, 25)

    const { data, error } = await supabase.rpc(
      'get_admin_balance_spend_summary_v1',
      {
        p_user_id: userId,
        p_limit: limit,
      }
    )

    if (error) throw error

    return res.status(200).json(
      data || {
        ok: true,
        user_id: userId,
        summary: {
          total_spent_diamonds: 0,
          episode_unlock_diamonds: 0,
          diamond_gift_diamonds: 0,
        },
        top_authors: [],
        top_stories: [],
        limit,
      }
    )
  } catch (error) {
    console.error('ADMIN BALANCE SPEND SUMMARY ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load Diamond spend summary',
      error: error.message,
    })
  }
}
