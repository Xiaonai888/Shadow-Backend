import { supabase } from '../config/supabase.js'

const PAID_MALL_STATUSES = [
  'under_review',
  'confirmed',
  'preparing',
  'shipped',
  'completed',
]
const PAID_AUTHOR_STORE_STATUSES = ['paid']
const UNPAID_EARNING_STATUSES = ['pending', 'available']
const PAID_EARNING_STATUSES = ['paid']
const REVENUE_TOLERANCE = 0.000001

function numberValue(value) {
  const number = Number(value || 0)

  if (!Number.isFinite(number)) return 0

  return number
}

function roundMoney(value) {
  return Number(numberValue(value).toFixed(2))
}

function roundAmount(value) {
  return Number(numberValue(value).toFixed(6))
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

  if (range.from) {
    nextQuery = nextQuery.gte(
      'created_at',
      range.from
    )
  }

  if (range.to) {
    nextQuery = nextQuery.lt(
      'created_at',
      range.to
    )
  }

  return nextQuery
}

function sumRows(rows, field) {
  return (rows || []).reduce(
    (total, row) =>
      total + numberValue(row[field]),
    0
  )
}

function earningUsd(row, diamondField) {
  return (
    numberValue(row[diamondField]) *
    numberValue(
      row.diamond_to_usd_rate || 0.01
    )
  )
}

async function getEpisodeOrderCount(range) {
  let query = supabase
    .from('story_reading_income_transactions')
    .select('purchase_key, income_status, created_at')
    .eq('currency', 'diamond')
    .neq('income_status', 'void')

  query = applyCreatedAtRange(query, range)

  const { data, error } = await query

  if (error) throw error

  return new Set(
    (data || [])
      .map((row) =>
        String(row.purchase_key || '').trim()
      )
      .filter(Boolean)
  ).size
}

async function getEpisodeIncome(range) {
  let query = supabase
    .from('author_earnings')
    .select(
      [
        'paid_diamonds',
        'net_paid_diamonds',
        'author_earned_diamonds',
        'platform_earned_diamonds',
        'author_net_payout_usd',
        'withholding_amount_usd',
        'diamond_to_usd_rate',
        'earning_status',
        'created_at',
      ].join(', ')
    )
    .eq('currency', 'diamond')
    .eq('source_type', 'diamond_unlock')
    .neq('earning_status', 'void')

  query = applyCreatedAtRange(query, range)

  const [
    { data, error },
    orderCount,
  ] = await Promise.all([
    query,
    getEpisodeOrderCount(range),
  ])

  if (error) throw error

  const rows = data || []

  const grossSalesUsd = rows.reduce(
    (total, row) =>
      total + earningUsd(row, 'paid_diamonds'),
    0
  )

  const distributableRevenueUsd = rows.reduce(
    (total, row) =>
      total +
      earningUsd(row, 'net_paid_diamonds'),
    0
  )

  const authorEarningsUsd = rows.reduce(
    (total, row) =>
      total +
      earningUsd(
        row,
        'author_earned_diamonds'
      ),
    0
  )

  const platformIncomeUsd = rows.reduce(
    (total, row) =>
      total +
      earningUsd(
        row,
        'platform_earned_diamonds'
      ),
    0
  )

  const withholdingUsd = sumRows(
    rows,
    'withholding_amount_usd'
  )

  const authorNetPayoutUsd = sumRows(
    rows,
    'author_net_payout_usd'
  )

  const pendingPayoutUsd = rows
    .filter((row) =>
      UNPAID_EARNING_STATUSES.includes(
        String(row.earning_status || '')
      )
    )
    .reduce(
      (total, row) =>
        total +
        numberValue(row.author_net_payout_usd),
      0
    )

  const paidPayoutUsd = rows
    .filter((row) =>
      PAID_EARNING_STATUSES.includes(
        String(row.earning_status || '')
      )
    )
    .reduce(
      (total, row) =>
        total +
        numberValue(row.author_net_payout_usd),
      0
    )

  const directCostUsd = Math.max(
    0,
    grossSalesUsd - distributableRevenueUsd
  )

  const splitTotalUsd =
    authorEarningsUsd + platformIncomeUsd

  const reconciliationDifferenceUsd =
    distributableRevenueUsd - splitTotalUsd

  const reconciliationStatus =
    Math.abs(reconciliationDifferenceUsd) <=
    REVENUE_TOLERANCE
      ? 'passed'
      : 'failed'

  return {
    source: 'episode_sales',
    gross_sales_usd:
      roundMoney(grossSalesUsd),
    direct_cost_usd:
      roundMoney(directCostUsd),
    distributable_revenue_usd:
      roundMoney(distributableRevenueUsd),
    platform_income_usd:
      roundMoney(platformIncomeUsd),
    author_earnings_usd:
      roundMoney(authorEarningsUsd),
    author_net_payout_usd:
      roundMoney(authorNetPayoutUsd),
    withholding_usd:
      roundMoney(withholdingUsd),
    pending_payout_usd:
      roundMoney(pendingPayoutUsd),
    paid_payout_usd:
      roundMoney(paidPayoutUsd),
    order_count: orderCount,
    earning_row_count: rows.length,
    order_count_source:
      'story_reading_income_transactions',
    revenue_source: 'author_earnings',
    reconciliation_status:
      reconciliationStatus,
    reconciliation_difference_usd:
      roundAmount(reconciliationDifferenceUsd),
  }
}

async function getDiamondGiftIncome(range) {
  let query = supabase
    .from('author_earnings')
    .select(
      [
        'paid_diamonds',
        'net_paid_diamonds',
        'author_earned_diamonds',
        'platform_earned_diamonds',
        'author_net_payout_usd',
        'withholding_amount_usd',
        'diamond_to_usd_rate',
        'earning_status',
        'created_at',
      ].join(', ')
    )
    .eq('currency', 'diamond')
    .eq('source_type', 'diamond_gift')
    .neq('earning_status', 'void')

  query = applyCreatedAtRange(query, range)

  const { data, error } = await query

  if (error) throw error

  const rows = data || []

  const grossSalesUsd = rows.reduce(
    (total, row) =>
      total + earningUsd(row, 'paid_diamonds'),
    0
  )

  const distributableRevenueUsd = rows.reduce(
    (total, row) =>
      total +
      earningUsd(row, 'net_paid_diamonds'),
    0
  )

  const authorEarningsUsd = rows.reduce(
    (total, row) =>
      total +
      earningUsd(
        row,
        'author_earned_diamonds'
      ),
    0
  )

  const platformIncomeUsd = rows.reduce(
    (total, row) =>
      total +
      earningUsd(
        row,
        'platform_earned_diamonds'
      ),
    0
  )

  const withholdingUsd = sumRows(
    rows,
    'withholding_amount_usd'
  )

  const authorNetPayoutUsd = sumRows(
    rows,
    'author_net_payout_usd'
  )

  const pendingPayoutUsd = rows
    .filter((row) =>
      UNPAID_EARNING_STATUSES.includes(
        String(row.earning_status || '')
      )
    )
    .reduce(
      (total, row) =>
        total +
        numberValue(row.author_net_payout_usd),
      0
    )

  const paidPayoutUsd = rows
    .filter((row) =>
      PAID_EARNING_STATUSES.includes(
        String(row.earning_status || '')
      )
    )
    .reduce(
      (total, row) =>
        total +
        numberValue(row.author_net_payout_usd),
      0
    )

  const directCostUsd = Math.max(
    0,
    grossSalesUsd - distributableRevenueUsd
  )

  const splitTotalUsd =
    authorEarningsUsd + platformIncomeUsd

  const reconciliationDifferenceUsd =
    distributableRevenueUsd - splitTotalUsd

  const reconciliationStatus =
    Math.abs(reconciliationDifferenceUsd) <=
    REVENUE_TOLERANCE
      ? 'passed'
      : 'failed'

  return {
    source: 'diamond_gifts',
    gross_sales_usd:
      roundMoney(grossSalesUsd),
    direct_cost_usd:
      roundMoney(directCostUsd),
    distributable_revenue_usd:
      roundMoney(distributableRevenueUsd),
    platform_income_usd:
      roundMoney(platformIncomeUsd),
    author_earnings_usd:
      roundMoney(authorEarningsUsd),
    author_net_payout_usd:
      roundMoney(authorNetPayoutUsd),
    withholding_usd:
      roundMoney(withholdingUsd),
    pending_payout_usd:
      roundMoney(pendingPayoutUsd),
    paid_payout_usd:
      roundMoney(paidPayoutUsd),
    order_count: 0,
    gift_transaction_count: rows.length,
    earning_row_count: rows.length,
    revenue_source: 'author_earnings',
    reconciliation_status:
      reconciliationStatus,
    reconciliation_difference_usd:
      roundAmount(reconciliationDifferenceUsd),
  }
}

async function getAuthorStoreIncome(range) {
  let query = supabase
    .from('author_store_orders')
    .select(
      'product_subtotal_usd, platform_fee_usd, author_income_usd, payment_status, created_at'
    )
    .in(
      'payment_status',
      PAID_AUTHOR_STORE_STATUSES
    )

  query = applyCreatedAtRange(query, range)

  const { data, error } = await query

  if (error) throw error

  const rows = data || []

  return {
    source: 'author_store',
    gross_sales_usd: roundMoney(
      sumRows(rows, 'product_subtotal_usd')
    ),
    platform_income_usd: roundMoney(
      sumRows(rows, 'platform_fee_usd')
    ),
    author_earnings_usd: roundMoney(
      sumRows(rows, 'author_income_usd')
    ),
    pending_payout_usd: roundMoney(
      sumRows(rows, 'author_income_usd')
    ),
    order_count: rows.length,
  }
}

async function getShadowMallIncome(range) {
  let query = supabase
    .from('shadow_mall_orders')
    .select(
      'subtotal_usd, delivery_fee_usd, total_usd, status, created_at'
    )
    .in('status', PAID_MALL_STATUSES)

  query = applyCreatedAtRange(query, range)

  const { data, error } = await query

  if (error) throw error

  const rows = data || []

  return {
    source: 'shadow_mall',
    gross_sales_usd: roundMoney(
      sumRows(rows, 'subtotal_usd')
    ),
    platform_income_usd: roundMoney(
      sumRows(rows, 'subtotal_usd')
    ),
    author_earnings_usd: 0,
    pending_payout_usd: 0,
    shipping_fee_usd: roundMoney(
      sumRows(rows, 'delivery_fee_usd')
    ),
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
    in_review_usd: roundMoney(
      rows
        .filter(
          (row) => row.status === 'in_review'
        )
        .reduce(
          (total, row) =>
            total + numberValue(row.amount_usd),
          0
        )
    ),
    approved_usd: roundMoney(
      rows
        .filter(
          (row) => row.status === 'approved'
        )
        .reduce(
          (total, row) =>
            total + numberValue(row.amount_usd),
          0
        )
    ),
    paid_usd: roundMoney(
      rows
        .filter(
          (row) => row.status === 'paid'
        )
        .reduce(
          (total, row) =>
            total + numberValue(row.amount_usd),
          0
        )
    ),
    rejected_usd: roundMoney(
      rows
        .filter(
          (row) => row.status === 'rejected'
        )
        .reduce(
          (total, row) =>
            total + numberValue(row.amount_usd),
          0
        )
    ),
    request_count: rows.length,
  }
}

export async function getAdminIncomeSummary(
  req,
  res
) {
  try {
    const range = getDateRange(req.query)

    const [
      episode,
      diamondGift,
      authorStore,
      shadowMall,
      withdrawals,
    ] = await Promise.all([
      getEpisodeIncome(range),
      getDiamondGiftIncome(range),
      getAuthorStoreIncome(range),
      getShadowMallIncome(range),
      getAuthorStoreWithdrawals(range),
    ])

    const sources = [
      episode,
      diamondGift,
      authorStore,
      shadowMall,
    ]

    const grossSalesUsd = sources.reduce(
      (total, source) =>
        total +
        numberValue(source.gross_sales_usd),
      0
    )

    const platformIncomeUsd = sources.reduce(
      (total, source) =>
        total +
        numberValue(source.platform_income_usd),
      0
    )

    const authorEarningsUsd = sources.reduce(
      (total, source) =>
        total +
        numberValue(source.author_earnings_usd),
      0
    )

    const pendingPayoutUsd =
      numberValue(episode.pending_payout_usd) +
      numberValue(
        diamondGift.pending_payout_usd
      ) +
      numberValue(
        authorStore.pending_payout_usd
      )

    const totalOrders = sources.reduce(
      (total, source) =>
        total + numberValue(source.order_count),
      0
    )

    return res.status(200).json({
      ok: true,
      range,
      summary: {
        gross_sales_usd:
          roundMoney(grossSalesUsd),
        platform_income_usd:
          roundMoney(platformIncomeUsd),
        net_platform_income_usd:
          roundMoney(platformIncomeUsd),
        author_earnings_usd:
          roundMoney(authorEarningsUsd),
        pending_payout_usd:
          roundMoney(pendingPayoutUsd),
        shadow_mall_income_usd:
          shadowMall.platform_income_usd,
        author_store_income_usd:
          authorStore.platform_income_usd,
        episode_platform_income_usd:
          episode.platform_income_usd,
        episode_author_payout_usd:
          episode.author_net_payout_usd,
        episode_author_earnings_usd:
          episode.author_earnings_usd,
        episode_distributable_revenue_usd:
          episode.distributable_revenue_usd,
        episode_direct_cost_usd:
          episode.direct_cost_usd,
        episode_withholding_usd:
          episode.withholding_usd,
        episode_paid_payout_usd:
          episode.paid_payout_usd,
        episode_reconciliation_status:
          episode.reconciliation_status,
        episode_reconciliation_difference_usd:
          episode.reconciliation_difference_usd,
        diamond_gift_gross_usd:
          diamondGift.gross_sales_usd,
        diamond_gift_platform_income_usd:
          diamondGift.platform_income_usd,
        diamond_gift_author_earnings_usd:
          diamondGift.author_earnings_usd,
        diamond_gift_author_payout_usd:
          diamondGift.author_net_payout_usd,
        diamond_gift_pending_payout_usd:
          diamondGift.pending_payout_usd,
        diamond_gift_paid_payout_usd:
          diamondGift.paid_payout_usd,
        diamond_gift_withholding_usd:
          diamondGift.withholding_usd,
        diamond_gift_transaction_count:
          diamondGift.gift_transaction_count,
        diamond_gift_reconciliation_status:
          diamondGift.reconciliation_status,
        diamond_gift_reconciliation_difference_usd:
          diamondGift.reconciliation_difference_usd,
        shipping_fee_excluded_usd:
          shadowMall.shipping_fee_usd,
        total_orders: totalOrders,
      },
      withdrawals,
      sources,
    })
  } catch (error) {
    console.error(
      'GET ADMIN INCOME SUMMARY ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to load admin income summary',
    })
  }
}

function normalizePayoutMonth(value) {
  const month = String(value || '').trim()

  if (!month) return ''

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    const error = new Error('Invalid payout month')
    error.statusCode = 400
    throw error
  }

  return month
}

function normalizePayoutStatus(value) {
  const status = String(value || '').trim()

  if (!status || status === 'all') return ''

  const allowed = [
    'scheduled',
    'paid',
    'failed',
    'missing_payment_method',
    'cancelled',
  ]

  if (!allowed.includes(status)) {
    const error = new Error('Invalid payout status')
    error.statusCode = 400
    throw error
  }

  return status
}

async function enrichAuthorPayouts(rows) {
  const authorIds = [
    ...new Set(
      (rows || [])
        .map((item) => item.author_id)
        .filter(Boolean)
    ),
  ]

  const userIds = [
    ...new Set(
      (rows || [])
        .map((item) => item.user_id)
        .filter(Boolean)
    ),
  ]

  const [
    { data: authorPages, error: authorPagesError },
    { data: users, error: usersError },
  ] = await Promise.all([
    authorIds.length
      ? supabase
          .from('author_pages')
          .select(
            'id, page_name, page_username, page_slug, user_id'
          )
          .in('id', authorIds)
      : Promise.resolve({
          data: [],
          error: null,
        }),
    userIds.length
      ? supabase
          .from('users')
          .select(
            'id, name, username, email'
          )
          .in('id', userIds)
      : Promise.resolve({
          data: [],
          error: null,
        }),
  ])

  if (authorPagesError) throw authorPagesError
  if (usersError) throw usersError

  const authorMap = new Map(
    (authorPages || []).map(
      (item) => [String(item.id), item]
    )
  )

  const userMap = new Map(
    (users || []).map(
      (item) => [String(item.id), item]
    )
  )

  return (rows || []).map((item) => ({
    ...item,
    author_page:
      authorMap.get(String(item.author_id)) ||
      null,
    author_user:
      userMap.get(String(item.user_id)) ||
      null,
  }))
}

function buildPayoutSummary(rows) {
  const summary = {
    total_count: 0,
    total_usd: 0,
    scheduled_count: 0,
    scheduled_usd: 0,
    paid_count: 0,
    paid_usd: 0,
    missing_payment_method_count: 0,
    missing_payment_method_usd: 0,
    failed_count: 0,
    failed_usd: 0,
    cancelled_count: 0,
    cancelled_usd: 0,
  }

  for (const row of rows || []) {
    const status = String(row.status || '')
    const amount = numberValue(row.net_payout_usd)

    summary.total_count += 1
    summary.total_usd += amount

    if (status === 'scheduled') {
      summary.scheduled_count += 1
      summary.scheduled_usd += amount
    } else if (status === 'paid') {
      summary.paid_count += 1
      summary.paid_usd += amount
    } else if (
      status === 'missing_payment_method'
    ) {
      summary.missing_payment_method_count += 1
      summary.missing_payment_method_usd += amount
    } else if (status === 'failed') {
      summary.failed_count += 1
      summary.failed_usd += amount
    } else if (status === 'cancelled') {
      summary.cancelled_count += 1
      summary.cancelled_usd += amount
    }
  }

  return {
    total_count: summary.total_count,
    total_usd: roundMoney(summary.total_usd),
    scheduled_count: summary.scheduled_count,
    scheduled_usd:
      roundMoney(summary.scheduled_usd),
    paid_count: summary.paid_count,
    paid_usd: roundMoney(summary.paid_usd),
    missing_payment_method_count:
      summary.missing_payment_method_count,
    missing_payment_method_usd:
      roundMoney(
        summary.missing_payment_method_usd
      ),
    failed_count: summary.failed_count,
    failed_usd: roundMoney(summary.failed_usd),
    cancelled_count: summary.cancelled_count,
    cancelled_usd:
      roundMoney(summary.cancelled_usd),
  }
}

export async function getAdminAuthorPayouts(
  req,
  res
) {
  try {
    const payoutMonth =
      normalizePayoutMonth(req.query.month)
    const status =
      normalizePayoutStatus(req.query.status)

    let query = supabase
      .from('author_payouts')
      .select('*')
      .order('payout_month', {
        ascending: false,
      })
      .order('created_at', {
        ascending: false,
      })
      .limit(1000)

    if (payoutMonth) {
      query = query.eq(
        'payout_month',
        payoutMonth
      )
    }

    if (status) {
      query = query.eq('status', status)
    }

    const { data, error } = await query

    if (error) throw error

    const rows = data || []
    const payouts =
      await enrichAuthorPayouts(rows)

    return res.status(200).json({
      ok: true,
      filters: {
        month: payoutMonth || null,
        status: status || 'all',
      },
      summary: buildPayoutSummary(rows),
      payouts,
    })
  } catch (error) {
    console.error(
      'GET ADMIN AUTHOR PAYOUTS ERROR:',
      error
    )

    return res
      .status(error.statusCode || 500)
      .json({
        ok: false,
        message:
          error.message ||
          'Failed to load author payouts',
      })
  }
}

export async function generateAdminAuthorPayouts(
  req,
  res
) {
  try {
    const payoutMonth =
      normalizePayoutMonth(
        req.body?.payout_month
      )

    const { data, error } = await supabase.rpc(
      'generate_author_payouts',
      {
        p_payout_month:
          payoutMonth || null,
      }
    )

    if (error) throw error

    return res.status(200).json({
      ok: true,
      result: data || null,
    })
  } catch (error) {
    console.error(
      'GENERATE ADMIN AUTHOR PAYOUTS ERROR:',
      error
    )

    return res
      .status(error.statusCode || 500)
      .json({
        ok: false,
        message:
          error.message ||
          'Failed to generate author payouts',
      })
  }
}

export async function markAdminAuthorPayoutPaid(
  req,
  res
) {
  try {
    const payoutId =
      String(req.params.id || '').trim()

    if (!payoutId) {
      return res.status(400).json({
        ok: false,
        message: 'Payout ID is required',
      })
    }

    const adminNote =
      String(req.body?.admin_note || '').trim()

    const { data, error } = await supabase.rpc(
      'mark_author_payout_paid',
      {
        p_payout_id: payoutId,
        p_admin_note:
          adminNote || null,
      }
    )

    if (error) throw error

    return res.status(200).json({
      ok: true,
      result: data || null,
    })
  } catch (error) {
    console.error(
      'MARK ADMIN AUTHOR PAYOUT PAID ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Failed to mark author payout paid',
    })
  }
}
