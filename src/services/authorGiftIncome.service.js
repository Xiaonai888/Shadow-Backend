import { supabase } from '../config/supabase.js'

const DEFAULT_DIAMOND_TO_USD_RATE = 0.01

function numberValue(value) {
  const number = Number(value || 0)
  return Number.isFinite(number) ? number : 0
}

function percentValue(value) {
  const number = Number(value || 0)
  if (!Number.isFinite(number)) return 0
  return Math.max(0, Math.min(100, number))
}

async function getRevenueSettings() {
  const { data, error } = await supabase
    .from('author_revenue_settings')
    .select(
      'diamond_to_usd_rate, withholding_enabled, withholding_percent'
    )
    .eq('id', 1)
    .maybeSingle()

  if (error) throw error

  return {
    diamond_to_usd_rate:
      numberValue(data?.diamond_to_usd_rate) > 0
        ? numberValue(data.diamond_to_usd_rate)
        : DEFAULT_DIAMOND_TO_USD_RATE,
    withholding_enabled: Boolean(data?.withholding_enabled),
    withholding_percent: percentValue(
      data?.withholding_percent
    ),
  }
}

export async function getAuthorGiftIncomeSummary({
  authorId,
  from,
  to = '',
}) {
  let query = supabase
    .from('story_gifts')
    .select(
      'author_earned_diamonds, created_at'
    )
    .eq('author_id', authorId)
    .eq('currency', 'diamond')
    .gt('author_earned_diamonds', 0)
    .gte('created_at', from)

  if (to) {
    query = query.lt('created_at', to)
  }

  const [
    { data, error },
    settings,
  ] = await Promise.all([
    query,
    getRevenueSettings(),
  ])

  if (error) throw error

  const totalDiamonds = (data || []).reduce(
    (sum, item) =>
      sum + numberValue(item.author_earned_diamonds),
    0
  )

  const grossUsd =
    totalDiamonds * settings.diamond_to_usd_rate
  const withholdingPercent =
    settings.withholding_enabled
      ? settings.withholding_percent
      : 0
  const withholdingUsd =
    grossUsd * (withholdingPercent / 100)

  return {
    total_diamonds: totalDiamonds,
    gross_usd: grossUsd,
    net_usd: Math.max(
      0,
      grossUsd - withholdingUsd
    ),
  }
}
