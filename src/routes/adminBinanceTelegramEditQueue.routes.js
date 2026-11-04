// STEP 7 — Read-only Admin monitor for the Binance Telegram EDIT-ONLY queue.
// This endpoint does not send Telegram messages, modify payments, or credit wallets.
import express from 'express'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { supabase } from '../config/supabase.js'

const router = express.Router()
const STATUSES = new Set(['all', 'pending', 'editing', 'retry', 'done', 'needs_review'])
const PAGE_SIZE = 10

// First route middleware: block abusive requests by IP before admin auth/session validation.
// Express-rate-limit's default key generator handles IPv4 and IPv6 safely.
const preAuthIpLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, code: 'BINANCE_EDIT_QUEUE_IP_RATE_LIMIT', message: 'Too many requests.' },
})

// Preserve the original 40/minute per-admin read limit, after requireAdmin.
const adminReadLimiter = rateLimit({
  windowMs: 60_000,
  limit: 40,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.admin?.admin_id || req.admin?.id || ipKeyGenerator(req.ip)),
  message: { ok: false, code: 'BINANCE_EDIT_QUEUE_RATE_LIMIT', message: 'Too many queue reads.' },
})

function preventPrivateCaching(_req, res, next) {
  res.set('Cache-Control', 'private, no-store')
  next()
}

// The route checker requires an explicit pre-auth IP limiter as the first argument.
router.get('/', preAuthIpLimiter, requireAdmin, preventPrivateCaching, adminReadLimiter, async (req, res) => {
  const role = String(req.admin?.role || '').trim().toLowerCase()
  if (!['owner', 'admin'].includes(role)) {
    return res.status(403).json({ ok: false, code: 'ADMIN_REQUIRED', message: 'Owner/Admin access required.' })
  }

  const status = String(req.query.status || 'all').trim().toLowerCase()
  if (!STATUSES.has(status)) {
    return res.status(400).json({ ok: false, code: 'INVALID_STATUS', message: 'Invalid queue status.' })
  }

  const rawPage = String(req.query.page || '1')
  if (!/^[1-9]\d{0,3}$/.test(rawPage)) {
    return res.status(400).json({ ok: false, code: 'INVALID_PAGE', message: 'Invalid page.' })
  }
  const page = Number(rawPage)
  if (page > 500) {
    return res.status(400).json({ ok: false, code: 'PAGE_TOO_LARGE', message: 'Maximum page is 500.' })
  }

  try {
    let query = supabase
      .from('shadow_binance_telegram_edit_queue')
      .select('transaction_id,purchase_kind,fulfillment_key,edit_status,attempt_count,next_attempt_at,claimed_at,telegram_edited_at,last_error,created_at,updated_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .order('transaction_id', { ascending: false })

    if (status !== 'all') query = query.eq('edit_status', status)
    const from = (page - 1) * PAGE_SIZE
    const { data, error, count } = await query.range(from, from + PAGE_SIZE - 1)
    if (error) throw error

    const rows = Array.isArray(data) ? data : []
    const transactionIds = rows.map((row) => row.transaction_id)
    let receiptById = new Map()
    if (transactionIds.length > 0) {
      const { data: receipts, error: receiptError } = await supabase
        .from('binance_usdt_alert_transactions')
        .select('transaction_id,delivery_status,telegram_message_id,telegram_sent_at')
        .in('transaction_id', transactionIds)
      if (receiptError) throw receiptError
      receiptById = new Map((receipts || []).map((item) => [item.transaction_id, item]))
    }

    const total = Number(count || 0)
    return res.status(200).json({
      ok: true,
      read_only: true,
      page,
      page_size: PAGE_SIZE,
      status,
      total,
      has_next: from + rows.length < total,
      items: rows.map((row) => {
        const receipt = receiptById.get(row.transaction_id)
        return {
          ...row,
          last_error: String(row.last_error || '').slice(0, 500) || null,
          original_report_status: receipt?.delivery_status || 'unknown',
          original_telegram_message_id: receipt?.telegram_message_id ?? null,
          original_telegram_sent_at: receipt?.telegram_sent_at ?? null,
        }
      }),
    })
  } catch (error) {
    console.error('ADMIN BINANCE TELEGRAM EDIT QUEUE READ ERROR:', String(error?.message || error).slice(0,200))
    return res.status(500).json({
      ok: false,
      code: 'EDIT_QUEUE_UNAVAILABLE',
      message: 'Unable to load Binance Telegram edit queue. Confirm the Step 5 SQL was installed.',
    })
  }
})

export default router
