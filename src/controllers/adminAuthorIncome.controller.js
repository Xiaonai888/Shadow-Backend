import { supabase } from '../config/supabase.js'
import { createAuthorEarningsFromDiamondUnlock } from '../services/authorRevenue.service.js'

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

let reconcilePromise = null

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
      }
    }

    const transactionIds = rows
      .map((row) => row.id)
      .filter(Boolean)

    const { data: earnings, error: earningsError } =
      await supabase
        .from('author_earnings')
        .select('unlock_transaction_id')
        .in('unlock_transaction_id', transactionIds)

    if (earningsError) throw earningsError

    const existingIds = new Set(
      (earnings || [])
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
            ...(transaction.metadata || {}),
          }
          const existingEventShare = Number(
            metadata.event_author_share_percent || 0
          )
          const historicalEventShare = Number(
            historicalEvent.share_percent || 0
          )

          metadata.event_author_share_percent =
            Math.max(
              Number.isFinite(existingEventShare)
                ? existingEventShare
                : 0,
              Number.isFinite(historicalEventShare)
                ? historicalEventShare
                : 0
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

    return {
      scanned: rows.length,
      missing: missingTransactions.length,
      repaired: repairedRows.length,
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
