// NEW: src/routes/adminBinanceTelegramReconcile.routes.js
// Resolve an ambiguous Binance Telegram delivery by EDITING an existing bot
// message. Never sends a new message, credits Diamonds, or grants vouchers.
import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { supabase } from '../config/supabase.js'
import { requireAdmin } from '../middleware/auth.middleware.js'
import { verifyAdminPasskeyPin } from '../services/adminPasskeyPin.service.js'
import { editTelegramMessage } from '../services/telegram.service.js'
import { formatBinanceUsdtAlertMessage } from '../services/binanceUsdtAlertWorker.service.js'
import { logAdminActivity, getAdminActor } from '../services/adminActivity.service.js'

const router = express.Router()
const TX_ID = /^[A-Za-z0-9_-]{1,128}$/
const MESSAGE_ID = /^[1-9]\d{0,14}$/

router.use(requireAdmin)
router.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, code: 'RECONCILE_RATE_LIMIT', message: 'Too many reconciliation attempts.' },
}))
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })

function adminAllowed(req, res) {
  if (!['owner', 'admin'].includes(String(req.admin?.role || '').toLowerCase())) {
    res.status(403).json({ ok: false, code: 'ADMIN_REQUIRED', message: 'Owner/Admin role required.' })
    return false
  }
  return true
}

function getTelegramChat() {
  const chatId = String(process.env.TELEGRAM_BINANCE_ALERT_CHAT_ID || '').trim()
  return /^-100\d{6,18}$/.test(chatId) ? chatId : null
}

function safeError(error) {
  return String(error?.message || error || 'Unknown error').replace(/[\r\n\t]/g, ' ').slice(0, 180)
}

async function verifiedPurchaseContext(transactionId) {
  const { data: claim, error } = await supabase
    .from('shadow_binance_payment_claims')
    .select('purchase_kind,fulfillment_key,user_id')
    .eq('transaction_id', transactionId)
    .maybeSingle()
  if (error) throw error
  if (!claim) return null
  let buyer = ''
  if (claim.user_id) {
    const { data: reader, error: readerError } = await supabase
      .from('users')
      .select('username,name')
      .eq('id', claim.user_id)
      .maybeSingle()
    if (readerError) throw readerError
    buyer = reader?.username ? `@${reader.username}` : String(reader?.name || '')
  }
  return {
    purchaseKind: claim.purchase_kind,
    fulfillmentKey: claim.fulfillment_key,
    buyer,
  }
}

router.post('/:transactionId/reconcile', async (req, res) => {
  if (!adminAllowed(req, res)) return

  const transactionId = String(req.params.transactionId || '').trim()
  const rawMessageId = String(req.body?.telegram_message_id ?? '').trim()
  const reason = String(req.body?.reason || '').trim()
  const passkey = String(req.body?.passkey || '').trim()

  if (!TX_ID.test(transactionId)) return res.status(400).json({ ok: false, code: 'INVALID_TRANSACTION_ID' })
  if (!MESSAGE_ID.test(rawMessageId) || !Number.isSafeInteger(Number(rawMessageId))) {
    return res.status(400).json({ ok: false, code: 'INVALID_MESSAGE_ID', message: 'Enter the existing Telegram bot message ID.' })
  }
  if (reason.length < 12 || reason.length > 500) {
    return res.status(400).json({ ok: false, code: 'INVALID_REASON', message: 'Reason must be 12–500 characters.' })
  }
  if (req.body?.verified_existing_message !== true || req.body?.verified_transaction_id !== true) {
    return res.status(400).json({ ok: false, code: 'VERIFICATION_REQUIRED', message: 'Confirm that the existing Telegram message contains this exact transaction ID.' })
  }
  if (!/^\d{6}$/.test(passkey)) {
    return res.status(400).json({ ok: false, code: 'PASSKEY_REQUIRED', message: 'Six-digit Admin Passkey required.' })
  }
  const chatId = getTelegramChat()
  if (!chatId) return res.status(503).json({ ok: false, code: 'TELEGRAM_CHAT_UNAVAILABLE' })

  try {
    const { data: alert, error } = await supabase
      .from('binance_usdt_alert_transactions')
      .select('transaction_id,transaction_time_ms,amount,currency,order_type,payer_name,delivery_status,telegram_message_id,telegram_sent_at,last_error')
      .eq('transaction_id', transactionId)
      .maybeSingle()
    if (error) throw error
    if (!alert) return res.status(404).json({ ok: false, code: 'RECEIPT_NOT_FOUND' })
    if (alert.delivery_status === 'sent' && alert.telegram_message_id) {
      return res.status(200).json({ ok: true, already_confirmed: true, telegram_message_id: alert.telegram_message_id, message: 'Report already confirmed. No new message sent.' })
    }
    if (alert.delivery_status !== 'sending' || !String(alert.last_error || '').startsWith('DELIVERY_UNKNOWN')) {
      return res.status(409).json({ ok: false, code: 'NOT_DELIVERY_UNKNOWN', message: 'Only ambiguous Telegram deliveries may be reconciled.' })
    }
    if (alert.telegram_message_id && String(alert.telegram_message_id) !== rawMessageId) {
      return res.status(409).json({ ok: false, code: 'MESSAGE_ID_MISMATCH', message: 'A different Telegram message ID is already recorded for this transaction.' })
    }

    const verified = await verifyAdminPasskeyPin({
      admin: req.admin,
      req,
      pin: passkey,
      purpose: `binance_telegram_reconcile:${transactionId}`,
    })
    if (!verified.ok) {
      return res.status(verified.status || 403).json({ ok: false, code: verified.code || 'PASSKEY_FAILED', message: verified.message || 'Invalid Admin Passkey.' })
    }

    let context = null
    try {
      context = await verifiedPurchaseContext(transactionId)
    } catch (contextError) {
      // Do not overwrite an existing more informative report with an unknown
      // purchase state when the verified payment ledger cannot be read.
      return res.status(503).json({ ok: false, code: 'PURCHASE_CONTEXT_UNAVAILABLE', message: 'Could not verify purchase context. Nothing changed.' })
    }

    // Telegram offers no getMessage method. We require Admin to check the
    // existing message manually, then prove the bot can EDIT that message.
    // This action does not call sendMessage and cannot create a duplicate.
    const text = formatBinanceUsdtAlertMessage(alert, context)
    try {
      const result = await editTelegramMessage(chatId, Number(rawMessageId), text)
      if (result?.ok !== true) throw new Error('Telegram edit not confirmed')
    } catch (telegramError) {
      const message = safeError(telegramError).toLowerCase()
      if (!message.includes('message is not modified')) {
        return res.status(409).json({ ok: false, code: 'TELEGRAM_MESSAGE_NOT_CONFIRMED', message: 'Could not edit that existing Telegram bot message. Check Chat and Message ID. No new message was sent.' })
      }
    }

    // CAS: two admins cannot confirm the same ambiguous report twice.
    let query = supabase.from('binance_usdt_alert_transactions')
      .update({
        delivery_status: 'sent',
        telegram_message_id: Number(rawMessageId),
        telegram_sent_at: new Date().toISOString(),
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('transaction_id', transactionId)
      .eq('delivery_status', 'sending')
      .like('last_error', 'DELIVERY_UNKNOWN%')
      .is('telegram_sent_at', null)
    query = alert.telegram_message_id
      ? query.eq('telegram_message_id', alert.telegram_message_id)
      : query.is('telegram_message_id', null)
    const { data: saved, error: updateError } = await query.select('transaction_id,telegram_message_id').maybeSingle()
    if (updateError) throw updateError
    if (!saved) return res.status(409).json({ ok: false, code: 'REPORT_ALREADY_CHANGED', message: 'Report status changed; refresh before proceeding.' })

    await logAdminActivity({
      action: 'UPDATE',
      section_key: 'binance_telegram',
      title: 'Reconciled existing Binance Telegram message',
      actor: getAdminActor(req),
      details: JSON.stringify({ transaction_id: transactionId, telegram_message_id: rawMessageId, reason, action: 'edit_only_no_new_message_no_wallet_credit' }),
    })
    return res.status(200).json({
      ok: true,
      telegram_message_id: saved.telegram_message_id,
      verified_by_edit: true,
      new_telegram_message_sent: false,
      wallet_changed: false,
      message: 'Existing Telegram report confirmed; no new message or credit was created.',
    })
  } catch (error) {
    console.error('BINANCE TELEGRAM RECONCILE ERROR:', safeError(error))
    return res.status(500).json({ ok: false, code: 'RECONCILE_FAILED', message: 'Failed to confirm existing report. No new message was sent.' })
  }
})

export default router
