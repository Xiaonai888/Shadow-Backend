import { supabase } from '../config/supabase.js'

const CAMBODIA_OFFSET_MS = 7 * 60 * 60 * 1000
const AUTHOR_INCOME_SOURCE_TYPES = [
  'diamond_unlock',
  'diamond_gift',
]

function numberValue(value) {
  const number = Number(value || 0)
  return Number.isFinite(number) ? number : 0
}

function getCambodiaBoundaries(date = new Date()) {
  const cambodiaDate = new Date(
    date.getTime() + CAMBODIA_OFFSET_MS
  )
  const year = cambodiaDate.getUTCFullYear()
  const month = cambodiaDate.getUTCMonth()
  const day = cambodiaDate.getUTCDate()

  return {
    todayStartIso: new Date(
      Date.UTC(year, month, day) -
        CAMBODIA_OFFSET_MS
    ).toISOString(),
    monthStartIso: new Date(
      Date.UTC(year, month, 1) -
        CAMBODIA_OFFSET_MS
    ).toISOString(),
  }
}

async function sumDiamondField({
  authorId,
  field,
  from,
  to = '',
}) {
  let query = supabase
    .from('author_earnings')
    .select(field)
    .eq('author_id', authorId)
    .eq('currency', 'diamond')
    .in('source_type', AUTHOR_INCOME_SOURCE_TYPES)
    .neq('earning_status', 'void')
    .gte('created_at', from)

  if (to) {
    query = query.lt('created_at', to)
  }

  const { data, error } = await query

  if (error) throw error

  return (data || []).reduce(
    (total, item) =>
      total + numberValue(item?.[field]),
    0
  )
}

function giftQuantity(metadata) {
  if (!metadata) return 1

  if (typeof metadata === 'string') {
    try {
      return Math.max(
        1,
        numberValue(JSON.parse(metadata)?.quantity)
      )
    } catch {
      return 1
    }
  }

  return Math.max(
    1,
    numberValue(metadata.quantity)
  )
}

async function getMonthlyGiftCount(
  authorId,
  monthStartIso
) {
  const { data, error } = await supabase
    .from('author_story_notifications')
    .select('metadata')
    .eq('author_id', authorId)
    .eq('type', 'gift')
    .gte('created_at', monthStartIso)

  if (error) throw error

  return (data || []).reduce(
    (total, item) =>
      total + giftQuantity(item.metadata),
    0
  )
}

export async function getAuthorProfileSummary(
  authorId
) {
  const {
    todayStartIso,
    monthStartIso,
  } = getCambodiaBoundaries()

  const [
    todayDiamonds,
    thisMonthUsd,
    monthlyGifts,
  ] = await Promise.all([
    sumDiamondField({
      authorId,
      field: 'author_earned_diamonds',
      from: todayStartIso,
    }),
    sumDiamondField({
      authorId,
      field: 'author_net_payout_usd',
      from: monthStartIso,
    }),
    getMonthlyGiftCount(
      authorId,
      monthStartIso
    ),
  ])

  return {
    today_diamonds: todayDiamonds,
    this_month_usd: thisMonthUsd,
    monthly_gifts: monthlyGifts,
  }
}
