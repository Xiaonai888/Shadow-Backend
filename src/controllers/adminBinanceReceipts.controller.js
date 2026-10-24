import { supabase } from '../config/supabase.js'

const PAGE_LIMIT = 10
const MAX_PAGE = 100000
const DAY_MS = 24 * 60 * 60 * 1000
const SEARCH_FIELDS = 'transaction_id,transaction_time_ms,amount,currency,order_type,payer_name,delivery_status,created_at'
const DETAIL_FIELDS = 'transaction_id,transaction_time_ms,amount,currency,order_type,payer_name,delivery_status,attempt_count,next_attempt_at,claimed_at,telegram_message_id,telegram_sent_at,last_error,created_at,updated_at'
const DELIVERY_STATES = new Set(['all', 'pending', 'sending', 'sent', 'failed'])
const SORT_VALUES = new Set(['newest', 'oldest', 'high', 'low'])
const TRANSACTION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

function authorize(req, res) {
  const role = String(req.admin?.role || '').trim().toLowerCase()
  if (!['owner', 'admin'].includes(role)) {
    res.status(403).json({ ok: false, message: 'Owner/Admin access is required' })
    return false
  }
  res.set('Cache-Control', 'no-store')
  return true
}

function fail(res, error, context) {
  console.error('ADMIN BINANCE RECEIPTS ERROR:', context, String(error?.code || ''), String(error?.message || '').slice(0,200))
  return res.status(500).json({ ok: false, message: 'Unable to load Binance receipt records' })
}

function readPage(value) {
  const page = Number.parseInt(String(value || '1'), 10)
  return Number.isSafeInteger(page) ? Math.min(MAX_PAGE, Math.max(1, page)) : 1
}

function parseFilters(req) {
  const rawSearch = String(req.query.q || '').trim()
  if (rawSearch.length > 80) throw new RangeError('Search must be 80 characters or fewer')
  const q = rawSearch.replace(/[^\p{L}\p{N}\s_-]/gu, ' ').replace(/\s+/g, ' ').trim()
  if (rawSearch && !q) throw new RangeError('Invalid receipt search')
  const status = String(req.query.status || 'all').trim().toLowerCase()
  if (!DELIVERY_STATES.has(status)) throw new RangeError('Invalid Telegram alert status')
  const sort = String(req.query.sort || 'newest').trim().toLowerCase()
  if (!SORT_VALUES.has(sort)) throw new RangeError('Invalid sorting option')
  const amount = String(req.query.amount || '').trim()
  if (amount && (!/^(?:0|[1-9]\d{0,17})(?:\.\d{1,8})?$/.test(amount) || Number(amount) <= 0)) {
    throw new RangeError('USDT amount must be positive with at most eight decimal places')
  }
  const date = String(req.query.date || '').trim()
  let startMs = null
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RangeError('Date must be YYYY-MM-DD')
    startMs = Date.parse(date + 'T00:00:00+07:00')
    if (!Number.isSafeInteger(startMs) || new Date(startMs + 7 * 60 * 60 * 1000).toISOString().slice(0, 10) !== date) {
      throw new RangeError('Invalid Cambodia date')
    }
  }
  return { page: readPage(req.query.page), q, status, sort, amount, date, startMs }
}

function applyFilters(query, filters) {
  let filtered = query
  if (filters.status !== 'all') filtered = filtered.eq('delivery_status', filters.status)
  if (filters.q) {
    const term = '%' + filters.q + '%'
    filtered = filtered.or('transaction_id.ilike.' + term + ',payer_name.ilike.' + term + ',order_type.ilike.' + term)
  }
  if (filters.amount) filtered = filtered.eq('amount', filters.amount)
  if (filters.startMs !== null) {
    filtered = filtered.gte('transaction_time_ms', filters.startMs).lt('transaction_time_ms', filters.startMs + DAY_MS)
  } else if (!filters.q) {
    filtered = filtered.gte('transaction_time_ms', Date.now() - 30 * DAY_MS)
  }
  if (filters.sort === 'high' || filters.sort === 'low') {
    filtered = filtered.order('amount', { ascending: filters.sort === 'low' })
      .order('transaction_time_ms', { ascending: false })
  } else {
    filtered = filtered.order('transaction_time_ms', { ascending: filters.sort === 'oldest' })
  }
  return filtered.order('transaction_id', { ascending: true })
}

function toReceipt(row) {
  return {
    transaction_id: row.transaction_id,
    transaction_time_ms: row.transaction_time_ms,
    amount_usdt: String(row.amount),
    currency: 'USDT',
    order_type: row.order_type || '',
    payer_name: row.payer_name || '',
    telegram_alert_status: row.delivery_status || 'unknown',
    created_at: row.created_at,
    source: 'binance_personal_pay_alert',
    account_match_status: 'not_recorded',
    diamond_credit_status: 'not_recorded',
    voucher_credit_status: 'not_recorded',
  }
}

async function listRecords(req, res, mode) {
  if (!authorize(req, res)) return
  let filters
  try {
    filters = parseFilters(req)
  } catch (error) {
    return res.status(400).json({ ok: false, message: error.message })
  }
  try {
    const offset = (filters.page - 1) * PAGE_LIMIT
    const fields = mode === 'alert_history' ? DETAIL_FIELDS : SEARCH_FIELDS
    const query = applyFilters(supabase.from('binance_usdt_alert_transactions').select(fields), filters)
    const { data, error } = await query.range(offset, offset + PAGE_LIMIT)
    if (error) throw error
    const rows = data || []
    const items = rows.slice(0, PAGE_LIMIT).map((row) => mode === 'alert_history'
      ? {
          ...toReceipt(row),
          attempt_count: row.attempt_count,
          next_attempt_at: row.next_attempt_at,
          telegram_message_id: row.telegram_message_id,
          telegram_sent_at: row.telegram_sent_at,
          last_alert_error: row.last_error || null,
          updated_at: row.updated_at,
        }
      : toReceipt(row))
    return res.status(200).json({
      ok: true,
      items,
      page: filters.page,
      limit: PAGE_LIMIT,
      has_next: rows.length > PAGE_LIMIT,
      has_prev: filters.page > 1,
      history_kind: mode === 'alert_history' ? 'telegram_alert_delivery_only' : 'received_usdt_receipts',
      read_only: true,
      credits_verified: false,
    })
  } catch (error) {
    return fail(res, error, mode)
  }
}

export async function getAdminBinanceReceivedUsdt(req, res) {
  return listRecords(req, res, 'receipts')
}

export async function getAdminBinanceAlertHistory(req, res) {
  return listRecords(req, res, 'alert_history')
}

export async function getAdminBinanceReceiptDetails(req, res) {
  if (!authorize(req, res)) return
  const transactionId = String(req.params.transactionId || '').trim()
  if (!TRANSACTION_ID_RE.test(transactionId)) {
    return res.status(400).json({ ok: false, message: 'Invalid Binance transaction ID' })
  }
  try {
    const { data, error } = await supabase
      .from('binance_usdt_alert_transactions')
      .select(DETAIL_FIELDS)
      .eq('transaction_id', transactionId)
      .maybeSingle()
    if (error) throw error
    if (!data) return res.status(404).json({ ok: false, message: 'Binance receipt was not found' })
    return res.status(200).json({
      ok: true,
      receipt: {
        ...toReceipt(data),
        attempt_count: data.attempt_count,
        next_attempt_at: data.next_attempt_at,
        claimed_at: data.claimed_at,
        telegram_message_id: data.telegram_message_id,
        telegram_sent_at: data.telegram_sent_at,
        last_alert_error: data.last_error || null,
        updated_at: data.updated_at,
      },
      read_only: true,
      warning: 'A payer name or Binance receipt alone does not prove which Shadow user should receive Diamonds.',
    })
  } catch (error) {
    return fail(res, error, 'details')
  }
}

export function getAdminBinanceCreditAvailability(req, res) {
  if (!authorize(req, res)) return
  return res.status(200).json({
    ok: true,
    manual_top_up_enabled: false,
    automatic_credit_enabled: false,
    planned_fixed_voucher_bonus: 100,
    source: 'binance_usdt_alert_transactions',
    message: 'Binance receipts are stored for review only. Verified recipient matching, an idempotent credit ledger, and atomic Diamond/Voucher crediting must be connected before financial actions can be enabled.',
  })
}
