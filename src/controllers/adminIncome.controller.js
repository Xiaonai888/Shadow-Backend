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

function parseBoundary(value, endExclusive = false) {
  const text = String(value || '').trim()

  if (!text) return null

  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text)
  const date = new Date(
    dateOnly ? `${text}T00:00:00+07:00` : text
  )

  if (Number.isNaN(date.getTime())) {
    const error = new Error('Invalid date range')
    error.statusCode = 400
    throw error
  }

  if (dateOnly && endExclusive) {
    date.setTime(date.getTime() + 24 * 60 * 60 * 1000)
  }

  return date.toISOString()
}

function getDateRange(query) {
  return {
    from: parseBoundary(query.from, false),
    to: parseBoundary(query.to, true),
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

function adminEpisodeSalesBoundary(value, endExclusive = false) {
  const text = String(value || '').trim()

  if (!text) return null

  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text)
  const date = new Date(
    dateOnly
      ? `${text}T00:00:00+07:00`
      : text
  )

  if (Number.isNaN(date.getTime())) {
    const error = new Error('Invalid date range')
    error.statusCode = 400
    throw error
  }

  if (endExclusive && dateOnly) {
    date.setTime(
      date.getTime() + 24 * 60 * 60 * 1000
    )
  }

  return date.toISOString()
}

function getAdminEpisodeSalesRange(query) {
  return {
    from: adminEpisodeSalesBoundary(
      query.from,
      false
    ),
    to: adminEpisodeSalesBoundary(
      query.to,
      true
    ),
  }
}

function metadataObject(value) {
  if (!value) return {}

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)

      return parsed &&
        typeof parsed === 'object'
        ? parsed
        : {}
    } catch {
      return {}
    }
  }

  return typeof value === 'object'
    ? value
    : {}
}

function episodeSalesRawPurchaseKey(row) {
  const metadata = metadataObject(row?.metadata)
  const metadataKey = String(
    metadata.purchase_key || ''
  ).trim()

  if (metadataKey) return metadataKey

  return String(row?.purchase_key || '')
    .replace(/^diamond-unlock:/, '')
    .trim()
}

function episodeSalesPayoutStatus(rows) {
  const statuses = (rows || []).map((row) =>
    String(row.earning_status || '').trim()
  )

  if (!statuses.length) return 'unknown'
  if (statuses.every((item) => item === 'paid')) {
    return 'paid'
  }
  if (statuses.some((item) => item === 'pending')) {
    return 'pending'
  }
  if (
    statuses.some((item) => item === 'available')
  ) {
    return 'available'
  }

  return statuses[0] || 'unknown'
}

function mapById(rows) {
  return new Map(
    (rows || [])
      .filter((row) => row?.id)
      .map((row) => [String(row.id), row])
  )
}

function groupByPurchaseMetadata(rows) {
  const map = new Map()

  for (const row of rows || []) {
    const metadata = metadataObject(row.metadata)
    const purchaseKey = String(
      metadata.purchase_key || ''
    ).trim()

    if (!purchaseKey) continue

    if (!map.has(purchaseKey)) {
      map.set(purchaseKey, [])
    }

    map.get(purchaseKey).push(row)
  }

  return map
}

export async function getAdminEpisodeSales(
  req,
  res
) {
  try {
    const range =
      getAdminEpisodeSalesRange(req.query)
    const queryText = String(
      req.query.q || ''
    )
      .trim()
      .toLowerCase()
    const status = String(
      req.query.status || 'all'
    )
      .trim()
      .toLowerCase()
    const page = Math.max(
      1,
      Math.floor(numberValue(req.query.page) || 1)
    )
    const limit = Math.min(
      100,
      Math.max(
        1,
        Math.floor(
          numberValue(req.query.limit) || 20
        )
      )
    )

    const allowedStatuses = [
      'all',
      'pending',
      'available',
      'paid',
      'unknown',
    ]

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid payout status',
      })
    }

    let purchaseQuery = supabase
      .from(
        'story_reading_income_transactions'
      )
      .select(
        [
          'purchase_key',
          'reader_id',
          'story_id',
          'author_id',
          'first_episode_id',
          'package_key',
          'episode_count',
          'currency',
          'original_diamonds',
          'package_discount_percent',
          'black_sunday_discount_percent',
          'paid_diamonds',
          'diamond_to_usd_rate',
          'platform_share_percent',
          'author_share_percent',
          'income_status',
          'metadata',
          'created_at',
          'updated_at',
        ].join(', ')
      )
      .eq('currency', 'diamond')
      .neq('income_status', 'void')
      .order('created_at', {
        ascending: false,
      })
      .limit(5000)

    let earningsQuery = supabase
      .from('author_earnings')
      .select(
        [
          'id',
          'author_id',
          'author_user_id',
          'reader_id',
          'story_id',
          'episode_id',
          'unlock_transaction_id',
          'paid_diamonds',
          'original_diamonds',
          'discount_percent',
          'net_paid_diamonds',
          'author_share_percent',
          'share_source',
          'author_earned_diamonds',
          'platform_earned_diamonds',
          'diamond_to_usd_rate',
          'author_gross_usd',
          'withholding_percent',
          'withholding_amount_usd',
          'author_net_payout_usd',
          'earning_status',
          'available_at',
          'metadata',
          'created_at',
        ].join(', ')
      )
      .eq('currency', 'diamond')
      .eq('source_type', 'diamond_unlock')
      .neq('earning_status', 'void')
      .limit(5000)

    let unlockTransactionQuery = supabase
      .from('episode_unlock_transactions')
      .select(
        [
          'id',
          'user_id',
          'story_id',
          'episode_id',
          'author_id',
          'currency',
          'amount',
          'transaction_type',
          'metadata',
          'created_at',
        ].join(', ')
      )
      .eq('currency', 'diamond')
      .eq('transaction_type', 'unlock')
      .limit(5000)

    purchaseQuery = applyCreatedAtRange(
      purchaseQuery,
      range
    )
    earningsQuery = applyCreatedAtRange(
      earningsQuery,
      range
    )
    unlockTransactionQuery =
      applyCreatedAtRange(
        unlockTransactionQuery,
        range
      )

    const [
      summary,
      purchaseResult,
      earningsResult,
      unlockTransactionResult,
    ] = await Promise.all([
      getEpisodeIncome(range),
      purchaseQuery,
      earningsQuery,
      unlockTransactionQuery,
    ])

    if (purchaseResult.error) {
      throw purchaseResult.error
    }
    if (earningsResult.error) {
      throw earningsResult.error
    }
    if (unlockTransactionResult.error) {
      throw unlockTransactionResult.error
    }

    const purchaseRows =
      purchaseResult.data || []
    const allEarningRows =
      earningsResult.data || []
    const allUnlockTransactions =
      unlockTransactionResult.data || []

    const rawPurchaseKeys = new Set(
      purchaseRows
        .map(episodeSalesRawPurchaseKey)
        .filter(Boolean)
    )

    const earningRows = allEarningRows.filter(
      (row) => {
        const metadata = metadataObject(
          row.metadata
        )
        return rawPurchaseKeys.has(
          String(
            metadata.purchase_key || ''
          ).trim()
        )
      }
    )

    const unlockTransactions =
      allUnlockTransactions.filter((row) => {
        const metadata = metadataObject(
          row.metadata
        )
        return rawPurchaseKeys.has(
          String(
            metadata.purchase_key || ''
          ).trim()
        )
      })

    const readerIds = [
      ...new Set(
        purchaseRows
          .map((row) => row.reader_id)
          .filter(Boolean)
      ),
    ]
    const storyIds = [
      ...new Set(
        purchaseRows
          .map((row) => row.story_id)
          .filter(Boolean)
      ),
    ]
    const authorIds = [
      ...new Set(
        purchaseRows
          .map((row) => row.author_id)
          .filter(Boolean)
      ),
    ]
    const episodeIds = [
      ...new Set(
        [
          ...purchaseRows.map(
            (row) => row.first_episode_id
          ),
          ...unlockTransactions.map(
            (row) => row.episode_id
          ),
        ].filter(Boolean)
      ),
    ]

    const [
      readersResult,
      storiesResult,
      authorsResult,
      episodesResult,
    ] = await Promise.all([
      readerIds.length
        ? supabase
            .from('users')
            .select(
              'id, name, username, email, avatar_url'
            )
            .in('id', readerIds)
        : Promise.resolve({
            data: [],
            error: null,
          }),
      storyIds.length
        ? supabase
            .from('stories')
            .select(
              'id, title, author_id, user_id'
            )
            .in('id', storyIds)
        : Promise.resolve({
            data: [],
            error: null,
          }),
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
      episodeIds.length
        ? supabase
            .from('episodes')
            .select(
              'id, story_id, title, episode_number'
            )
            .in('id', episodeIds)
        : Promise.resolve({
            data: [],
            error: null,
          }),
    ])

    if (readersResult.error) {
      throw readersResult.error
    }
    if (storiesResult.error) {
      throw storiesResult.error
    }
    if (authorsResult.error) {
      throw authorsResult.error
    }
    if (episodesResult.error) {
      throw episodesResult.error
    }

    const readerMap = mapById(
      readersResult.data
    )
    const storyMap = mapById(
      storiesResult.data
    )
    const authorMap = mapById(
      authorsResult.data
    )
    const episodeMap = mapById(
      episodesResult.data
    )
    const earningsByPurchase =
      groupByPurchaseMetadata(earningRows)
    const transactionsByPurchase =
      groupByPurchaseMetadata(
        unlockTransactions
      )
    const earningByUnlockTransaction =
      new Map(
        earningRows
          .filter(
            (row) => row.unlock_transaction_id
          )
          .map((row) => [
            String(row.unlock_transaction_id),
            row,
          ])
      )

    let transactions = purchaseRows.map(
      (purchase) => {
        const metadata = metadataObject(
          purchase.metadata
        )
        const rawPurchaseKey =
          episodeSalesRawPurchaseKey(purchase)
        const purchaseEarnings =
          earningsByPurchase.get(
            rawPurchaseKey
          ) || []
        const purchaseUnlockTransactions =
          transactionsByPurchase.get(
            rawPurchaseKey
          ) || []

        const rate = numberValue(
          purchase.diamond_to_usd_rate ||
            purchaseEarnings[0]
              ?.diamond_to_usd_rate ||
            0.01
        )

        const authorEarnedDiamonds =
          purchaseEarnings.reduce(
            (sum, row) =>
              sum +
              numberValue(
                row.author_earned_diamonds
              ),
            0
          )
        const platformEarnedDiamonds =
          purchaseEarnings.reduce(
            (sum, row) =>
              sum +
              numberValue(
                row.platform_earned_diamonds
              ),
            0
          )
        const distributableDiamonds =
          purchaseEarnings.reduce(
            (sum, row) =>
              sum +
              numberValue(
                row.net_paid_diamonds
              ),
            0
          )
        const withholdingUsd =
          purchaseEarnings.reduce(
            (sum, row) =>
              sum +
              numberValue(
                row.withholding_amount_usd
              ),
            0
          )
        const authorNetPayoutUsd =
          purchaseEarnings.reduce(
            (sum, row) =>
              sum +
              numberValue(
                row.author_net_payout_usd
              ),
            0
          )
        const paidPayoutUsd =
          purchaseEarnings
            .filter(
              (row) =>
                row.earning_status === 'paid'
            )
            .reduce(
              (sum, row) =>
                sum +
                numberValue(
                  row.author_net_payout_usd
                ),
              0
            )
        const pendingPayoutUsd =
          purchaseEarnings
            .filter((row) =>
              UNPAID_EARNING_STATUSES.includes(
                String(
                  row.earning_status || ''
                )
              )
            )
            .reduce(
              (sum, row) =>
                sum +
                numberValue(
                  row.author_net_payout_usd
                ),
              0
            )

        const directCostDiamonds =
          numberValue(
            metadata.direct_cost_diamonds
          ) ||
          Math.max(
            0,
            numberValue(
              purchase.paid_diamonds
            ) - distributableDiamonds
          )

        const reader = readerMap.get(
          String(purchase.reader_id)
        ) || null
        const story = storyMap.get(
          String(purchase.story_id)
        ) || null
        const author = authorMap.get(
          String(purchase.author_id)
        ) || null

        const episodes =
          purchaseUnlockTransactions
            .map((transaction) => {
              const transactionMetadata =
                metadataObject(
                  transaction.metadata
                )
              const episode =
                episodeMap.get(
                  String(
                    transaction.episode_id
                  )
                ) || null
              const earning =
                earningByUnlockTransaction.get(
                  String(transaction.id)
                ) || null

              return {
                id:
                  transaction.episode_id ||
                  null,
                episode_number:
                  numberValue(
                    episode?.episode_number ??
                      transactionMetadata
                        .episode_number
                  ),
                title:
                  episode?.title ||
                  transactionMetadata
                    .episode_title ||
                  '',
                paid_diamonds:
                  numberValue(
                    transaction.amount
                  ),
                author_earned_diamonds:
                  numberValue(
                    earning
                      ?.author_earned_diamonds
                  ),
                platform_earned_diamonds:
                  numberValue(
                    earning
                      ?.platform_earned_diamonds
                  ),
                earning_status:
                  earning?.earning_status ||
                  'unknown',
                unlock_transaction_id:
                  transaction.id,
              }
            })
            .sort(
              (a, b) =>
                numberValue(
                  a.episode_number
                ) -
                numberValue(
                  b.episode_number
                )
            )

        const firstEpisode =
          episodeMap.get(
            String(
              purchase.first_episode_id
            )
          ) ||
          episodes[0] ||
          null

        const authorEarningsUsd =
          purchaseEarnings.reduce(
            (sum, row) =>
              sum +
              numberValue(
                row.author_earned_diamonds
              ) *
                numberValue(
                  row.diamond_to_usd_rate ||
                    rate
                ),
            0
          )

        const platformIncomeUsd =
          purchaseEarnings.reduce(
            (sum, row) =>
              sum +
              numberValue(
                row.platform_earned_diamonds
              ) *
                numberValue(
                  row.diamond_to_usd_rate ||
                    rate
                ),
            0
          )

        return {
          purchase_key:
            purchase.purchase_key,
          source_purchase_key:
            rawPurchaseKey,
          created_at:
            purchase.created_at,
          updated_at:
            purchase.updated_at,
          package_key:
            purchase.package_key ||
            metadata.package_key ||
            'single',
          episode_count:
            numberValue(
              purchase.episode_count
            ) || episodes.length,
          original_diamonds:
            numberValue(
              purchase.original_diamonds
            ),
          paid_diamonds:
            numberValue(
              purchase.paid_diamonds
            ),
          diamond_to_usd_rate: rate,
          gross_sales_usd: roundMoney(
            numberValue(
              purchase.paid_diamonds
            ) * rate
          ),
          direct_cost_usd: roundMoney(
            directCostDiamonds * rate
          ),
          distributable_revenue_usd:
            roundMoney(
              distributableDiamonds * rate
            ),
          author_earnings_usd:
            roundMoney(authorEarningsUsd),
          platform_income_usd:
            roundMoney(platformIncomeUsd),
          author_net_payout_usd:
            roundMoney(authorNetPayoutUsd),
          withholding_usd:
            roundMoney(withholdingUsd),
          pending_payout_usd:
            roundMoney(pendingPayoutUsd),
          paid_payout_usd:
            roundMoney(paidPayoutUsd),
          author_share_percent:
            numberValue(
              purchase.author_share_percent ||
                purchaseEarnings[0]
                  ?.author_share_percent
            ),
          platform_share_percent:
            numberValue(
              purchase.platform_share_percent
            ),
          share_source:
            purchaseEarnings[0]
              ?.share_source ||
            metadata
              .effective_share_source ||
            '',
          payout_status:
            episodeSalesPayoutStatus(
              purchaseEarnings
            ),
          income_status:
            purchase.income_status ||
            'completed',
          buyer: reader
            ? {
                id: reader.id,
                name: reader.name || '',
                username:
                  reader.username || '',
                email: reader.email || '',
                avatar_url:
                  reader.avatar_url || '',
              }
            : null,
          story: story
            ? {
                id: story.id,
                title: story.title || '',
              }
            : {
                id:
                  purchase.story_id ||
                  null,
                title: '',
              },
          author: author
            ? {
                id: author.id,
                user_id:
                  author.user_id || null,
                page_name:
                  author.page_name || '',
                page_username:
                  author.page_username || '',
                page_slug:
                  author.page_slug || '',
              }
            : {
                id:
                  purchase.author_id ||
                  null,
                page_name: '',
                page_username: '',
                page_slug: '',
              },
          first_episode: firstEpisode
            ? {
                id:
                  firstEpisode.id ||
                  purchase.first_episode_id ||
                  null,
                episode_number:
                  numberValue(
                    firstEpisode
                      .episode_number
                  ),
                title:
                  firstEpisode.title || '',
              }
            : null,
          episodes,
          metadata,
        }
      }
    )

    if (status !== 'all') {
      transactions = transactions.filter(
        (item) =>
          item.payout_status === status
      )
    }

    if (queryText) {
      transactions = transactions.filter(
        (item) => {
          const episodeText = (
            item.episodes || []
          )
            .map(
              (episode) =>
                `${episode.episode_number} ${episode.title}`
            )
            .join(' ')

          return [
            item.purchase_key,
            item.source_purchase_key,
            item.buyer?.name,
            item.buyer?.username,
            item.buyer?.email,
            item.story?.title,
            item.author?.page_name,
            item.author?.page_username,
            item.package_key,
            episodeText,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
            .includes(queryText)
        }
      )
    }

    const total = transactions.length
    const totalPages = Math.max(
      1,
      Math.ceil(total / limit)
    )
    const safePage = Math.min(
      page,
      totalPages
    )
    const start =
      (safePage - 1) * limit
    const pagedTransactions =
      transactions.slice(
        start,
        start + limit
      )

    return res.status(200).json({
      ok: true,
      range,
      filters: {
        q: queryText,
        status,
      },
      summary,
      pagination: {
        page: safePage,
        limit,
        total,
        total_pages: totalPages,
        has_prev: safePage > 1,
        has_next:
          safePage < totalPages,
      },
      transactions:
        pagedTransactions,
      truncated_source_scan:
        purchaseRows.length >= 5000 ||
        allEarningRows.length >= 5000 ||
        allUnlockTransactions.length >=
          5000,
    })
  } catch (error) {
    console.error(
      'GET ADMIN EPISODE SALES ERROR:',
      error
    )

    return res
      .status(error.statusCode || 500)
      .json({
        ok: false,
        message:
          error.message ||
          'Failed to load episode sales',
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
