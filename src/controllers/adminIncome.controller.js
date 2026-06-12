import { supabase } from '../config/supabase.js'

const PAID_MALL_STATUSES = ['under_review', 'confirmed', 'preparing', 'shipped', 'completed']
const PAID_AUTHOR_STORE_STATUSES = ['paid']

function numberValue(value) {
  const number = Number(value || 0)

  if (!Number.isFinite(number)) return 0

  return number
}

function roundMoney(value) {
  return Number(numberValue(value).toFixed(2))
}

function getDateRange(query) {
  const from = String(query.from || '').trim()
  const to = String(query.to || '').trim()

  return {
    from: from ? new Date(from).toISOString() : null,
    to: to ? new Date(to).toISOString() : null,
  }
}

function applyCreatedAtRange(query, range) {
  let nextQuery = query

  if (range.from) nextQuery = nextQuery.gte('created_at', range.from)
  if (range.to) nextQuery = nextQuery.lte('created_at', range.to)

  return nextQuery
}

function sumRows(rows, field) {
  return (rows || []).reduce((total, row) => total + numberValue(row[field]), 0)
}

async function getEpisodeIncome(range) {
  let query = supabase
    .from('author_earnings')
    .select('paid_diamonds, platform_earned_diamonds, author_net_payout_usd, diamond_to_usd_rate, earning_status, created_at')
    .neq('earning_status', 'void')

  query = applyCreatedAtRange(query, range)

  const { data, error } = await query

  if (error) throw error

  const rows = data || []
  const grossUsd = rows.reduce(
    (total, row) => total + numberValue(row.paid_diamonds) * numberValue(row.diamond_to_usd_rate || 0.01),
    0,
  )
  const platformIncomeUsd = rows.reduce(
    (total, row) => total + numberValue(row.platform_earned_diamonds) * numberValue(row.diamond_to_usd_rate || 0.01),
    0,
  )
  const authorEarningsUsd = sumRows(rows, 'author_net_payout_usd')

  return {
    source: 'episode_sales',
    gross_sales_usd: roundMoney(grossUsd),
    platform_income_usd: roundMoney(platformIncomeUsd),
    author_earnings_usd: roundMoney(authorEarningsUsd),
    pending_payout_usd: roundMoney(authorEarningsUsd),
    order_count: rows.length,
  }
}

async function getAuthorStoreIncome(range) {
  let query = supabase
    .from('author_store_orders')
    .select('product_subtotal_usd, platform_fee_usd, author_income_usd, payment_status, created_at')
    .in('payment_status', PAID_AUTHOR_STORE_STATUSES)

  query = applyCreatedAtRange(query, range)

  const { data, error } = await query

  if (error) throw error

  const rows = data || []

  return {
    source: 'author_store',
    gross_sales_usd: roundMoney(sumRows(rows, 'product_subtotal_usd')),
    platform_income_usd: roundMoney(sumRows(rows, 'platform_fee_usd')),
    author_earnings_usd: roundMoney(sumRows(rows, 'author_income_usd')),
    pending_payout_usd: roundMoney(sumRows(rows, 'author_income_usd')),
    order_count: rows.length,
  }
}

async function getShadowMallIncome(range) {
  let query = supabase
    .from('shadow_mall_orders')
    .select('subtotal_usd, delivery_fee_usd, total_usd, status, created_at')
    .in('status', PAID_MALL_STATUSES)

  query = applyCreatedAtRange(query, range)

  const { data, error } = await query

  if (error) throw error

  const rows = data || []

  return {
    source: 'shadow_mall',
    gross_sales_usd: roundMoney(sumRows(rows, 'subtotal_usd')),
    platform_income_usd: roundMoney(sumRows(rows, 'subtotal_usd')),
    author_earnings_usd: 0,
    pending_payout_usd: 0,
    shipping_fee_usd: roundMoney(sumRows(rows, 'delivery_fee_usd')),
    order_count: rows.length,
  }
}

async function getAuthorStoreWithdrawals(range) {
  let query = supabase
    .from('author_store_withdrawal_requests')
    .select('amount_usd, status, created_at')
    .is('deleted_at', null)

  query = applyCreatedAtRange(query, range)

  const { data, error } = await query

  if (error) throw error

  const rows = data || []

  return {
    in_review_usd: roundMoney(rows.filter((row) => row.status === 'in_review').reduce((total, row) => total + numberValue(row.amount_usd), 0)),
    approved_usd: roundMoney(rows.filter((row) => row.status === 'approved').reduce((total, row) => total + numberValue(row.amount_usd), 0)),
    paid_usd: roundMoney(rows.filter((row) => row.status === 'paid').reduce((total, row) => total + numberValue(row.amount_usd), 0)),
    rejected_usd: roundMoney(rows.filter((row) => row.status === 'rejected').reduce((total, row) => total + numberValue(row.amount_usd), 0)),
    request_count: rows.length,
  }
}

export async function getAdminIncomeSummary(req, res) {
  try {
    const range = getDateRange(req.query)

    const [episode, authorStore, shadowMall, withdrawals] = await Promise.all([
      getEpisodeIncome(range),
      getAuthorStoreIncome(range),
      getShadowMallIncome(range),
      getAuthorStoreWithdrawals(range),
    ])

    const sources = [episode, authorStore, shadowMall]

    const grossSalesUsd = sources.reduce((total, source) => total + numberValue(source.gross_sales_usd), 0)
    const platformIncomeUsd = sources.reduce((total, source) => total + numberValue(source.platform_income_usd), 0)
    const authorEarningsUsd = sources.reduce((total, source) => total + numberValue(source.author_earnings_usd), 0)
    const pendingPayoutUsd = numberValue(episode.pending_payout_usd) + numberValue(authorStore.pending_payout_usd)
    const totalOrders = sources.reduce((total, source) => total + numberValue(source.order_count), 0)

    return res.status(200).json({
      ok: true,
      range,
      summary: {
        gross_sales_usd: roundMoney(grossSalesUsd),
        platform_income_usd: roundMoney(platformIncomeUsd),
        net_platform_income_usd: roundMoney(platformIncomeUsd),
        author_earnings_usd: roundMoney(authorEarningsUsd),
        pending_payout_usd: roundMoney(pendingPayoutUsd),
        shadow_mall_income_usd: shadowMall.platform_income_usd,
        author_store_income_usd: authorStore.platform_income_usd,
        episode_platform_income_usd: episode.platform_income_usd,
        episode_author_payout_usd: episode.author_earnings_usd,
        shipping_fee_excluded_usd: shadowMall.shipping_fee_usd,
        total_orders: totalOrders,
      },
      withdrawals,
      sources,
    })
  } catch (error) {
    console.error('GET ADMIN INCOME SUMMARY ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to load admin income summary',
    })
  }
}
