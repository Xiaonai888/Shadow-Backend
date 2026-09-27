import { supabase } from '../config/supabase.js'
import { createAuthorEarningsFromDiamondUnlock } from '../services/authorRevenue.service.js'
import { createStoryReadingIncome } from '../services/storyReadingIncome.service.js'

const ALLOWED_STATUSES = new Set([
  'all',
  'pending',
  'available',
  'paid',
  'unknown',
])

const ALLOWED_SORTS = new Set([
  'author_earned_desc',
  'paid_diamonds_desc',
  'platform_earned_desc',
  'transactions_desc',
  'latest_desc',
])

function toPositiveInt(value, fallback, max) {
  const number = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(number) || number < 1) return fallback
  return Math.min(number, max)
}

function cleanText(value, max = 80) {
  return String(value || '').trim().slice(0, max)
}

function parseBoundary(value, endExclusive = false) {
  const text = cleanText(value, 64)

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


const RECONCILE_LIMIT = 100
const REVENUE_TOLERANCE = 0.000001

let reconcilePromise = null

function numberValue(value) {
  const number = Number(value || 0)
  return Number.isFinite(number) ? number : 0
}

function metadataObject(value) {
  if (!value) return {}

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object'
        ? parsed
        : {}
    } catch {
      return {}
    }
  }

  return typeof value === 'object' ? value : {}
}

function transactionPurchaseKey(transaction) {
  const metadata = metadataObject(transaction?.metadata)
  return String(metadata.purchase_key || '').trim()
}

function storyIncomePurchaseKey(purchaseKey) {
  return `diamond-unlock:${purchaseKey}`
}

function uniqueValues(rows, getter) {
  return [
    ...new Set(
      (rows || [])
        .map(getter)
        .filter(
          (value) =>
            value !== null &&
            value !== undefined &&
            String(value).trim() !== ''
        )
        .map((value) => String(value))
    ),
  ]
}

async function getReconcileEarnings(transactionIds) {
  if (!transactionIds.length) return []

  const { data, error } = await supabase
    .from('author_earnings')
    .select(
      [
        'id',
        'unlock_transaction_id',
        'author_id',
        'author_user_id',
        'reader_id',
        'story_id',
        'episode_id',
        'paid_diamonds',
        'original_diamonds',
        'discount_percent',
        'net_paid_diamonds',
        'author_share_percent',
        'share_source',
        'author_earned_diamonds',
        'platform_earned_diamonds',
        'diamond_to_usd_rate',
        'earning_status',
        'metadata',
        'created_at',
      ].join(',')
    )
    .in('unlock_transaction_id', transactionIds)
    .eq('currency', 'diamond')
    .eq('source_type', 'diamond_unlock')
    .neq('earning_status', 'void')

  if (error) throw error

  return data || []
}

async function reconcileStoryReadingIncome({
  transactions,
  earnings,
}) {
  const earningsByTransaction = new Map()

  for (const earning of earnings || []) {
    const key = String(
      earning.unlock_transaction_id || ''
    ).trim()

    if (!key) continue

    if (!earningsByTransaction.has(key)) {
      earningsByTransaction.set(key, [])
    }

    earningsByTransaction.get(key).push(earning)
  }

  const purchaseGroups = new Map()

  for (const transaction of transactions || []) {
    const purchaseKey =
      transactionPurchaseKey(transaction)

    if (!purchaseKey) continue

    if (!purchaseGroups.has(purchaseKey)) {
      purchaseGroups.set(purchaseKey, [])
    }

    purchaseGroups.get(purchaseKey).push(transaction)
  }

  const purchaseKeys = [...purchaseGroups.keys()]

  if (!purchaseKeys.length) {
    return {
      sales_scanned: 0,
      sales_missing: 0,
      sales_repaired: 0,
      sales_skipped_incomplete: 0,
    }
  }

  const incomeKeys = purchaseKeys.map(
    storyIncomePurchaseKey
  )
  const { data: existingIncome, error: incomeError } =
    await supabase
      .from('story_reading_income_transactions')
      .select('purchase_key,paid_diamonds')
      .in('purchase_key', incomeKeys)

  if (incomeError) throw incomeError

  const existingIncomeMap = new Map(
    (existingIncome || []).map((row) => [
      String(row.purchase_key),
      row,
    ])
  )
  const repairedIncomeKeys = []
  const expectedPaidByIncomeKey = new Map()
  let salesMissing = 0
  let salesSkippedIncomplete = 0

  for (const [purchaseKey, sourceRows] of purchaseGroups) {
    const incomeKey = storyIncomePurchaseKey(
      purchaseKey
    )

    if (existingIncomeMap.has(incomeKey)) {
      continue
    }

    salesMissing += 1

    const purchaseRows = [...sourceRows].sort(
      (a, b) => {
        const aMetadata = metadataObject(a.metadata)
        const bMetadata = metadataObject(b.metadata)
        const episodeDifference =
          numberValue(aMetadata.episode_number) -
          numberValue(bMetadata.episode_number)

        if (episodeDifference) {
          return episodeDifference
        }

        return (
          new Date(a.created_at).getTime() -
          new Date(b.created_at).getTime()
        )
      }
    )
    const firstTransaction = purchaseRows[0]
    const metadata = metadataObject(
      firstTransaction.metadata
    )
    const expectedEpisodeCount = Math.max(
      0,
      Math.floor(numberValue(metadata.episode_count))
    )
    const transactionPaidDiamonds =
      purchaseRows.reduce(
        (total, row) =>
          total + numberValue(row.amount),
        0
      )
    const expectedPaidDiamonds = numberValue(
      metadata.final_price ||
        metadata.package_total_amount
    )

    if (
      (expectedEpisodeCount > 0 &&
        purchaseRows.length !== expectedEpisodeCount) ||
      (expectedPaidDiamonds > 0 &&
        Math.abs(
          transactionPaidDiamonds -
            expectedPaidDiamonds
        ) > REVENUE_TOLERANCE)
    ) {
      salesSkippedIncomplete += 1
      continue
    }

    const purchaseEarnings = []
    let earningsComplete = true

    for (const transaction of purchaseRows) {
      const transactionEarnings =
        earningsByTransaction.get(
          String(transaction.id)
        ) || []

      if (transactionEarnings.length !== 1) {
        earningsComplete = false
        break
      }

      purchaseEarnings.push(transactionEarnings[0])
    }

    if (!earningsComplete) {
      salesSkippedIncomplete += 1
      continue
    }

    const readerIds = uniqueValues(
      purchaseRows,
      (row) => row.user_id
    )
    const storyIds = uniqueValues(
      purchaseRows,
      (row) => row.story_id
    )
    const authorIds = uniqueValues(
      purchaseRows,
      (row) => row.author_id
    )
    const sharePercents = uniqueValues(
      purchaseEarnings,
      (row) => numberValue(row.author_share_percent)
    )
    const shareSources = uniqueValues(
      purchaseEarnings,
      (row) => row.share_source
    )

    if (
      readerIds.length !== 1 ||
      storyIds.length !== 1 ||
      authorIds.length !== 1 ||
      sharePercents.length !== 1 ||
      shareSources.length !== 1
    ) {
      throw new Error(
        `Episode sales reconciliation found inconsistent purchase data (${purchaseKey})`
      )
    }

    const paidDiamonds = purchaseEarnings.reduce(
      (total, row) =>
        total + numberValue(row.paid_diamonds),
      0
    )
    const distributableNetRevenueDiamonds =
      purchaseEarnings.reduce(
        (total, row) =>
          total + numberValue(row.net_paid_diamonds),
        0
      )
    const authorEarnedDiamonds =
      purchaseEarnings.reduce(
        (total, row) =>
          total +
          numberValue(row.author_earned_diamonds),
        0
      )
    const platformEarnedDiamonds =
      purchaseEarnings.reduce(
        (total, row) =>
          total +
          numberValue(row.platform_earned_diamonds),
        0
      )

    if (
      Math.abs(
        paidDiamonds - transactionPaidDiamonds
      ) > REVENUE_TOLERANCE ||
      Math.abs(
        distributableNetRevenueDiamonds -
          authorEarnedDiamonds -
          platformEarnedDiamonds
      ) > REVENUE_TOLERANCE
    ) {
      throw new Error(
        `Episode sales reconciliation does not balance (${purchaseKey})`
      )
    }

    const directCostDiamonds = Math.max(
      0,
      paidDiamonds - distributableNetRevenueDiamonds
    )
    const originalDiamonds =
      numberValue(metadata.original_price) ||
      purchaseEarnings.reduce(
        (total, row) =>
          total + numberValue(row.original_diamonds),
        0
      ) ||
      paidDiamonds
    const authorSharePercent = numberValue(
      purchaseEarnings[0].author_share_percent
    )
    const shareSource = String(
      purchaseEarnings[0].share_source || ''
    ).trim()
    const diamondToUsdRate = numberValue(
      purchaseEarnings[0].diamond_to_usd_rate
    ) || 0.01
    const purchaseCreatedAt =
      purchaseRows.reduce(
        (earliest, row) => {
          const current = new Date(
            row.created_at
          ).getTime()

          if (!Number.isFinite(current)) {
            return earliest
          }

          return Math.min(earliest, current)
        }, Infinity)
    const createdAt = Number.isFinite(
      purchaseCreatedAt
    )
      ? new Date(purchaseCreatedAt).toISOString()
      : new Date().toISOString()

    await createStoryReadingIncome({
      purchaseKey: incomeKey,
      readerId: readerIds[0],
      storyId: storyIds[0],
      authorId: authorIds[0],
      firstEpisodeId:
        firstTransaction.episode_id || null,
      packageKey:
        String(metadata.package_key || '').trim() ||
        'single',
      episodeCount: purchaseRows.length,
      originalDiamonds,
      packageDiscountPercent:
        metadata.package_discount_percent ??
        metadata.discount_percent ??
        0,
      blackSundayDiscountPercent:
        metadata.black_sunday_discount_percent || 0,
      paidDiamonds,
      authorSharePercent,
      shareSource,
      authorEarnedDiamonds,
      platformEarnedDiamonds,
      directCostDiamonds,
      distributableNetRevenueDiamonds,
      metadata: {
        ...metadata,
        purchase_key: purchaseKey,
        revenue_source: 'author_earnings',
        effective_author_share_percent:
          authorSharePercent,
        effective_share_source: shareSource,
      },
    })

    const { error: historicalError } = await supabase
      .from('story_reading_income_transactions')
      .update({
        created_at: createdAt,
        diamond_to_usd_rate: diamondToUsdRate,
        updated_at: new Date().toISOString(),
      })
      .eq('purchase_key', incomeKey)

    if (historicalError) throw historicalError

    repairedIncomeKeys.push(incomeKey)
    expectedPaidByIncomeKey.set(
      incomeKey,
      paidDiamonds
    )
  }

  if (repairedIncomeKeys.length) {
    const { data: verifiedIncome, error: verifyError } =
      await supabase
        .from('story_reading_income_transactions')
        .select('purchase_key,paid_diamonds')
        .in('purchase_key', repairedIncomeKeys)

    if (verifyError) throw verifyError

    const verifiedMap = new Map(
      (verifiedIncome || []).map((row) => [
        String(row.purchase_key),
        row,
      ])
    )

    for (const incomeKey of repairedIncomeKeys) {
      const row = verifiedMap.get(incomeKey)
      const expectedPaid =
        expectedPaidByIncomeKey.get(incomeKey) || 0

      if (
        !row ||
        Math.abs(
          numberValue(row.paid_diamonds) -
            expectedPaid
        ) > REVENUE_TOLERANCE
      ) {
        throw new Error(
          `Episode sales reconciliation verification failed (${incomeKey})`
        )
      }
    }
  }

  return {
    sales_scanned: purchaseKeys.length,
    sales_missing: salesMissing,
    sales_repaired: repairedIncomeKeys.length,
    sales_skipped_incomplete:
      salesSkippedIncomplete,
  }
}

async function runAuthorIncomeReconciliation() {
  if (reconcilePromise) return reconcilePromise

  reconcilePromise = (async () => {
    const { data: transactions, error: transactionsError } =
      await supabase
        .from('episode_unlock_transactions')
        .select(
          'id,user_id,story_id,episode_id,author_id,currency,amount,transaction_type,metadata,created_at'
        )
        .eq('currency', 'diamond')
        .eq('transaction_type', 'unlock')
        .gt('amount', 0)
        .not('author_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(RECONCILE_LIMIT)

    if (transactionsError) throw transactionsError

    const rows = transactions || []

    if (!rows.length) {
      return {
        scanned: 0,
        missing: 0,
        repaired: 0,
        sales_scanned: 0,
        sales_missing: 0,
        sales_repaired: 0,
        sales_skipped_incomplete: 0,
      }
    }

    const transactionIds = rows
      .map((row) => row.id)
      .filter(Boolean)

    const existingEarnings =
      await getReconcileEarnings(transactionIds)
    const existingIds = new Set(
      existingEarnings
        .map((row) => row.unlock_transaction_id)
        .filter(Boolean)
    )
    const missingTransactions = rows.filter(
      (row) => !existingIds.has(row.id)
    )

    let repairTransactions = missingTransactions

    if (missingTransactions.length) {
      const authorIds = [
        ...new Set(
          missingTransactions
            .map((row) => row.author_id)
            .filter(Boolean)
        ),
      ]

      const { data: eventRows, error: eventError } =
        await supabase
          .from('author_49_day_event_progress')
          .select(
            'author_id,share_percent,started_at,ends_at,ended_at,status'
          )
          .in('author_id', authorIds)

      if (eventError) throw eventError

      repairTransactions = missingTransactions.map(
        (transaction) => {
          const transactionTime = new Date(
            transaction.created_at
          ).getTime()
          const historicalEvent = (eventRows || []).find(
            (event) => {
              if (
                event.author_id !== transaction.author_id
              ) {
                return false
              }

              const startedAt = new Date(
                event.started_at
              ).getTime()
              const endedAt = new Date(
                event.ended_at || event.ends_at
              ).getTime()

              return (
                Number.isFinite(transactionTime) &&
                Number.isFinite(startedAt) &&
                Number.isFinite(endedAt) &&
                transactionTime >= startedAt &&
                transactionTime < endedAt
              )
            }
          )

          if (!historicalEvent) return transaction

          const metadata = {
            ...metadataObject(transaction.metadata),
          }
          const existingEventShare = numberValue(
            metadata.event_author_share_percent
          )
          const historicalEventShare = numberValue(
            historicalEvent.share_percent
          )

          metadata.event_author_share_percent =
            Math.max(
              existingEventShare,
              historicalEventShare
            )

          return {
            ...transaction,
            metadata,
          }
        }
      )
    }

    const repairedRows = repairTransactions.length
      ? await createAuthorEarningsFromDiamondUnlock({
          transactions: repairTransactions,
        })
      : []

    if (
      missingTransactions.length &&
      repairedRows.length !== missingTransactions.length
    ) {
      throw new Error(
        `Author income reconciliation is incomplete (${repairedRows.length}/${missingTransactions.length})`
      )
    }

    const finalEarnings =
      await getReconcileEarnings(transactionIds)
    const finalEarningIds = new Set(
      finalEarnings
        .map((row) => row.unlock_transaction_id)
        .filter(Boolean)
    )
    const stillMissing = rows.filter(
      (row) => !finalEarningIds.has(row.id)
    )

    if (stillMissing.length) {
      throw new Error(
        `Author income reconciliation verification failed (${rows.length - stillMissing.length}/${rows.length})`
      )
    }

    const salesResult =
      await reconcileStoryReadingIncome({
        transactions: rows,
        earnings: finalEarnings,
      })

    return {
      scanned: rows.length,
      missing: missingTransactions.length,
      repaired: repairedRows.length,
      ...salesResult,
    }
  })()

  try {
    return await reconcilePromise
  } finally {
    reconcilePromise = null
  }
}

export async function reconcileAdminAuthorIncome(req, res) {
  try {
    const result = await runAuthorIncomeReconciliation()

    return res.status(200).json({
      ok: true,
      ...result,
    })
  } catch (error) {
    console.error('RECONCILE ADMIN AUTHOR INCOME ERROR:', error)

    return res
      .status(error.statusCode || 500)
      .json({
        ok: false,
        message:
          error.message ||
          'Failed to reconcile author income',
      })
  }
}

export async function getAdminAuthorIncome(req, res) {
  try {
    const page = toPositiveInt(req.query.page, 1, 100000)
    const limit = toPositiveInt(req.query.limit, 20, 50)
    const search = cleanText(req.query.q)
    const shareSource = cleanText(req.query.share_source, 64).toLowerCase()
    const statusRaw = cleanText(req.query.status, 24).toLowerCase() || 'all'
    const sortRaw = cleanText(req.query.sort, 40).toLowerCase() || 'author_earned_desc'
    const status = ALLOWED_STATUSES.has(statusRaw) ? statusRaw : 'all'
    const sort = ALLOWED_SORTS.has(sortRaw) ? sortRaw : 'author_earned_desc'
    const from = parseBoundary(req.query.from, false)
    const to = parseBoundary(req.query.to, true)

    const { data, error } = await supabase.rpc(
      'get_admin_author_income_v1',
      {
        p_page: page,
        p_limit: limit,
        p_search: search,
        p_from: from,
        p_to: to,
        p_share_source: shareSource,
        p_status: status,
        p_sort: sort,
      }
    )

    if (error) throw error

    return res.status(200).json(
      data || {
        ok: true,
        source: 'author_earnings',
        summary: {
          paid_diamonds: 0,
          net_paid_diamonds: 0,
          author_earned_diamonds: 0,
          platform_earned_diamonds: 0,
          author_earnings_usd: 0,
          platform_income_usd: 0,
          author_net_payout_usd: 0,
          withholding_usd: 0,
          pending_payout_usd: 0,
          paid_payout_usd: 0,
          transaction_count: 0,
          author_count: 0,
          reconciliation_difference_diamonds: 0,
        },
        items: [],
        pagination: {
          page,
          limit,
          total: 0,
          total_pages: 0,
          has_prev: page > 1,
          has_next: false,
        },
      }
    )
  } catch (error) {
    console.error('GET ADMIN AUTHOR INCOME ERROR:', error)

    return res
      .status(error.statusCode || 500)
      .json({
        ok: false,
        message:
          error.message ||
          'Failed to load author income',
      })
  }
}
