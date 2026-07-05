import { supabase } from '../config/supabase.js'

const ALLOWED_METRICS = new Set([
  'page_views',
  'story_reads',
  'interactions',
  'new_followers',
  'comments',
])

export async function incrementAuthorPageAnalytics(
  authorPageId,
  metric,
  amount = 1
) {
  const safeAmount = Number(amount)

  if (!authorPageId || !ALLOWED_METRICS.has(metric)) return false
  if (!Number.isFinite(safeAmount) || safeAmount < 1) return false

  const { error } = await supabase.rpc(
    'increment_author_page_daily_metric',
    {
      p_author_page_id: authorPageId,
      p_metric: metric,
      p_amount: Math.floor(safeAmount),
      p_stat_date: new Date().toISOString().slice(0, 10),
    }
  )

  if (error) {
    console.error('AUTHOR PAGE ANALYTICS INCREMENT ERROR:', {
      authorPageId,
      metric,
      amount: safeAmount,
      error: error.message,
    })
    return false
  }

  return true
}
