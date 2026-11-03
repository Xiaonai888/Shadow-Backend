import { supabase } from '../config/supabase.js'
import { fetchBinanceUsdtIncome } from './binanceUsdtPay.service.js'
import { html, sendTelegramMessage } from './telegram.service.js'
import { publishPaymentStatus } from './paymentEvents.service.js'

const POLL_INTERVAL_MS = 10 * 60 * 1000
const CATCH_UP_INTERVAL_MS = 15 * 1000
const CATCH_UP_THRESHOLD_MS = 10 * 60 * 1000
const ANCILLARY_ERROR_LOG_INTERVAL_MS = 10 * 60 * 1000
const MAX_RETRY_INTERVAL_MS = 60 * 60 * 1000
const MAX_QUERY_WINDOW_MS = 6 * 60 * 60 * 1000
const MIN_QUERY_WINDOW_MS = 60 * 1000
const MAX_API_ROWS = 100
const MAX_DELIVERY_BATCH = 10

let started = false
let running = false
let timer = null
let failures = 0
let queryWindowMs = MAX_QUERY_WINDOW_MS
let wasCatchingUp = false
let lastMatchErrorLogAt = 0
let lastTelegramErrorLogAt = 0

function getAlertChatId() {
  const chatId = String(process.env.TELEGRAM_BINANCE_ALERT_CHAT_ID || '').trim()
  return /^-100\d{6,18}$/.test(chatId) ? chatId : ''
}

function hasBinanceApiCredentials() {
  return Boolean(String(process.env.BINANCE_USDT_API_KEY || '').trim())
    && Boolean(String(process.env.BINANCE_USDT_API_SECRET || '').trim())
}

function isIngestionEnabled() {
  return process.env.BINANCE_USDT_ALERT_ENABLED === 'true'
    && hasBinanceApiCredentials()
}

function isTelegramDeliveryEnabled() {
  return Boolean(String(process.env.TELEGRAM_BOT_TOKEN || '').trim())
    && Boolean(getAlertChatId())
}

function safeError(error) {
  const message = String(error?.message || error || 'Unknown error')
  return message.replace(/[\r\n\t]/g, ' ').slice(0, 300)
}

// Use the same transaction's committed global fulfillment claim for a
// purchase label. Never infer Diamond / Premium / PDF from amount or payer name.
async function findVerifiedReportContext(transactionId) {
  try {
    const { data, error } = await supabase
      .from('shadow_binance_payment_claims')
      .select('purchase_kind,fulfillment_key,user_id')
      .eq('transaction_id', transactionId)
      .maybeSingle()
    if (error) throw error
    if (!data) return null

    let buyer = ''
    if (data.user_id) {
      const { data: user, error: userError } = await supabase
        .from('users')
        .select('name,username')
        .eq('id', data.user_id)
        .maybeSingle()
      if (userError) throw userError
      buyer = user?.username ? '@' + user.username : String(user?.name || '')
    }
    return {
      purchaseKind: String(data.purchase_kind || '').toLowerCase(),
      fulfillmentKey: String(data.fulfillment_key || ''),
      buyer,
    }
  } catch (error) {
    // Report receipt independently of purchase matching.
    console.warn('BINANCE REPORT CONTEXT UNAVAILABLE:', safeError(error))
    return null
  }
}

function purchaseLabel(kind) {
  const names = {
    diamonds: 'Shadow Diamond Store',
    premium: 'Shadow Premium',
    pdf: 'Author PDF Store',
    manual_adjustment: 'Admin Manual Credit',
  }
  return names[kind] || (kind ? kind.replaceAll('_', ' ') : 'Unmatched / not verified')
}

export function formatBinanceUsdtAlertMessage(row, verifiedContext = null) {
  const timestamp = Number(row?.transaction_time_ms)
  const when = Number.isSafeInteger(timestamp) && timestamp > 0
    ? new Date(timestamp).toLocaleString('en-GB', {
        timeZone: 'Asia/Bangkok',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
    : 'Unknown'
  const payer = String(row?.payer_name || '').trim()
  const orderType = String(row?.order_type || '').trim()
  const purchase = verifiedContext ? purchaseLabel(verifiedContext.purchaseKind) : 'Unmatched / not verified'

  return [
    '💰 <b>SHADOW BINANCE USDT RECEIVED</b>',
    '',
    '💳 Payment Source: <b>Binance Personal Pay · USDT</b>',
    orderType ? `🔁 Transfer Type: <b>${html(orderType)}</b>` : null,
    `💵 Amount Received: <b>${html(row?.amount)} USDT</b>`,
    payer ? `👤 From: <b>${html(payer)}</b>` : '👤 From: Unknown',
    `🏷️ Purchase Source: <b>${html(purchase)}</b>`,
    verifiedContext?.buyer ? `👤 Shadow Buyer: <b>${html(verifiedContext.buyer)}</b>` : null,
    verifiedContext?.fulfillmentKey ? `📦 Order Reference: <code>${html(verifiedContext.fulfillmentKey)}</code>` : null,
    `📋 Status: <b>${verifiedContext ? 'Fulfillment recorded' : 'Received · Awaiting order verification'}</b>`,
    `🧾 Transaction ID: <code>${html(row?.transaction_id)}</code>`,
    `🕒 Time: ${html(when)} (Cambodia)`,
    '',
    'ℹ️ A received transfer alone does not confirm a Shadow purchase.',
  ].filter((value) => value !== null).join('\n')
}

async function ingestBinanceReceipts() {
  const { data: cursorRow, error: cursorError } = await supabase
    .from('binance_usdt_alert_cursor')
    .select('cursor_ms')
    .eq('source', 'personal_pay')
    .maybeSingle()

  if (cursorError) throw cursorError
  if (!cursorRow) throw new Error('Binance USDT alert cursor is missing')

  const cursor = Number(cursorRow.cursor_ms)
  const now = Date.now()
  if (!Number.isSafeInteger(cursor) || cursor <= 0) {
    throw new Error('Invalid Binance USDT alert cursor')
  }
  if (cursor >= now) return { idle: true, ingested: 0 }

  const endTime = Math.min(now, cursor + queryWindowMs)
  const overlapMs = Math.min(10 * 60 * 1000, Math.floor(queryWindowMs / 4))
  const startTime = Math.max(0, cursor - overlapMs)
  const page = await fetchBinanceUsdtIncome({
    startTime,
    endTime,
    limit: MAX_API_ROWS,
  })

  if (page.possibleMore) {
    queryWindowMs = Math.max(MIN_QUERY_WINDOW_MS, Math.floor(queryWindowMs / 2))
    throw new Error('Binance Pay history is full; reducing the next query window')
  }

  if (page.receipts.length) {
    const rows = page.receipts.map((item) => ({
      transaction_id: item.transactionId,
      transaction_time_ms: item.transactionTime,
      amount: item.amount,
      currency: 'USDT',
      order_type: item.orderType,
      payer_name: item.payerName,
      payer_uid: item.payerUid,
      receiver_uid: item.receiverUid,
    }))

    const { error: insertError } = await supabase
      .from('binance_usdt_alert_transactions')
      .upsert(rows, { onConflict: 'transaction_id', ignoreDuplicates: true })

    if (insertError) throw insertError
  }

  const { data: updated, error: updateError } = await supabase
    .from('binance_usdt_alert_cursor')
    .update({ cursor_ms: endTime, updated_at: new Date().toISOString() })
    .eq('source', 'personal_pay')
    .eq('cursor_ms', cursor)
    .select('cursor_ms')
    .maybeSingle()

  if (updateError) throw updateError
  if (!updated) return { concurrent: true, ingested: page.receipts.length }

  queryWindowMs = Math.min(MAX_QUERY_WINDOW_MS, queryWindowMs * 2)
  return { ingested: page.receipts.length, cursorMs: endTime }
}

// Telegram sendMessage has no idempotency key. A timeout or lost response can
// mean the message was delivered while the Backend did not learn its ID.
// Keep the durable claim in "sending" (excluded by claim_binance_usdt_alerts)
// until an Admin checks Telegram. Never turn an uncertain send into a retry.
async function markDeliveryUnknown(alert, reason, knownMessageId = null) {
  const updates = {
    last_error: `DELIVERY_UNKNOWN / VERIFY_IN_TELEGRAM: ${safeError(reason)}`.slice(0, 500),
    updated_at: new Date().toISOString(),
  }

  // Recover a known Telegram message ID if the first "sent" database write
  // failed. The row stays unclaimable even if this second write fails.
  if (Number.isSafeInteger(knownMessageId) && knownMessageId > 0) {
    updates.telegram_message_id = knownMessageId
  }

  const { error } = await supabase
    .from('binance_usdt_alert_transactions')
    .update(updates)
    .eq('transaction_id', alert.transaction_id)
    .eq('delivery_status', 'sending')
  if (error) throw error
}

async function quarantineUncertainDelivery(alert, reason, knownMessageId = null) {
  try {
    await markDeliveryUnknown(alert, reason, knownMessageId)
  } catch (error) {
    // The durable claim is already "sending" even if diagnostics cannot save.
    console.error('BINANCE TELEGRAM DELIVERY UNKNOWN (DB UPDATE FAILED):', {
      transaction_id: alert.transaction_id,
      reason: safeError(reason),
      database_error: safeError(error),
    })
    return
  }
  console.warn('BINANCE TELEGRAM DELIVERY UNKNOWN / MANUAL REVIEW:', {
    transaction_id: alert.transaction_id,
    reason: safeError(reason),
  })
}

async function deliverPendingAlerts() {
  // Keep pending receipts unclaimed until a Telegram destination is available.
  if (!isTelegramDeliveryEnabled()) {
    return { skipped: true, reason: 'telegram_not_configured', sent: 0, claimed: 0 }
  }

  const chatId = getAlertChatId()
  const { data: alerts, error: claimError } = await supabase
    .rpc('claim_binance_usdt_alerts', { p_limit: MAX_DELIVERY_BATCH })

  if (claimError) throw claimError
  if (!Array.isArray(alerts) || alerts.length > MAX_DELIVERY_BATCH) {
    throw new Error('Invalid Binance USDT alert delivery batch')
  }

  let sent = 0
  let uncertain = 0

  for (const alert of alerts) {
    // First-time delivery MUST be attempt 1. Existing failed deliveries
    // may already have reached Telegram before an earlier DB error.
    if (Number(alert.attempt_count) !== 1) {
      uncertain += 1
      await quarantineUncertainDelivery(
        alert,
        'An earlier delivery attempt exists; verify the previous message before any resend.'
      )
      continue
    }

    // Defence in depth: the claim RPC already excludes sent message metadata.
    if (alert.telegram_message_id || alert.telegram_sent_at) {
      uncertain += 1
      await quarantineUncertainDelivery(alert, 'Telegram message metadata already exists.')
      continue
    }

    let messageId = null
    try {
      const verifiedContext = await findVerifiedReportContext(alert.transaction_id)
      const delivered = await sendTelegramMessage(formatBinanceUsdtAlertMessage(alert, verifiedContext), {
        chat_id: chatId,
      })
      messageId = Number(delivered?.result?.message_id)
      if (delivered?.ok !== true || !Number.isSafeInteger(messageId) || messageId <= 0) {
        // Even an incomplete response may follow successful delivery.
        throw new Error('Telegram result missing confirmed message ID.')
      }
    } catch (error) {
      uncertain += 1
      await quarantineUncertainDelivery(alert, error)
      continue
    }

    try {
      const { data: saved, error: saveError } = await supabase
        .from('binance_usdt_alert_transactions')
        .update({
          delivery_status: 'sent',
          telegram_message_id: messageId,
          telegram_sent_at: new Date().toISOString(),
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq('transaction_id', alert.transaction_id)
        .eq('delivery_status', 'sending')
        .select('transaction_id')
        .maybeSingle()

      if (saveError) throw saveError
      if (!saved) throw new Error('The message state changed or DB confirmation is missing.')
      sent += 1
    } catch (error) {
      uncertain += 1
      await quarantineUncertainDelivery(
        alert,
        `Telegram accepted message ${messageId}, DB confirmation failed: ${safeError(error)}`,
        messageId
      )
    }
  }

  return { sent, uncertain, claimed: alerts.length }
}

export async function processBinanceUsdtAlertsOnce() {
  if (!isIngestionEnabled()) {
    return { skipped: true, reason: 'binance_history_not_configured' }
  }
  if (running) return { skipped: true, running: true }

  running = true
  let ingestError = null
  let deliveryError = null
  let matchError = null
  let ingest = null
  let delivery = null
  let matching = null

  try {
    try {
      ingest = await ingestBinanceReceipts()
      if (ingest?.ingested > 0) {
        console.info('BINANCE USDT RECEIPTS RECORDED:', ingest.ingested)
      }
    } catch (error) {
      ingestError = error
    }

    // Only an independently verified payer UID permits automatic credit.
    try {
      const { data, error } = await supabase.rpc('auto_credit_binance_checkout_v1', {
        p_limit: 10,
      })
      if (error) throw error
      matching = data
      if (Number(data?.credited || 0) > 0) {
        console.info('BINANCE AUTO CREDITED ORDERS:', data.credited)
      }
      for (const creditedOrder of Array.isArray(data?.credited_orders) ? data.credited_orders : []) {
        if (!creditedOrder?.order_id || !creditedOrder?.user_id) continue
        publishPaymentStatus({
          user_id: creditedOrder.user_id,
          order_id: creditedOrder.order_id,
          status: 'success',
          diamonds: creditedOrder.diamonds,
          bonus_gems: 0,
          released_at: creditedOrder.credited_at || null,
          updated_at: creditedOrder.credited_at || null,
        })
      }
    } catch (error) {
      matchError = error
    }

    // Always attempt Telegram delivery even if an unrelated order match fails.
    try {
      delivery = await deliverPendingAlerts()
    } catch (error) {
      deliveryError = error
    }

    // Checkout and Telegram are independent of history ingestion. An RPC
    // failure must never slow down receipt catch-up or hide the Admin ledger.
    if (matchError && Date.now() - lastMatchErrorLogAt >= ANCILLARY_ERROR_LOG_INTERVAL_MS) {
      lastMatchErrorLogAt = Date.now()
      console.error('BINANCE USDT CHECKOUT MATCH ERROR:', safeError(matchError))
    }
    if (deliveryError && Date.now() - lastTelegramErrorLogAt >= ANCILLARY_ERROR_LOG_INTERVAL_MS) {
      lastTelegramErrorLogAt = Date.now()
      console.error('BINANCE USDT TELEGRAM ERROR:', safeError(deliveryError))
    }
    if (ingestError) {
      throw new Error(`history: ${safeError(ingestError)}`)
    }

    return { ingest, matching, delivery }
  } finally {
    running = false
  }
}

function schedule(delayMs) {
  if (!started || !isIngestionEnabled()) return
  if (timer) clearTimeout(timer)

  timer = setTimeout(async () => {
    timer = null
    let nextDelay = POLL_INTERVAL_MS

    try {
      const result = await processBinanceUsdtAlertsOnce()
      failures = 0

      // Preserve the cursor: each successful bounded window advances it.
      // Catch-up runs at no more than four history requests per minute.
      const cursorMs = Number(result?.ingest?.cursorMs)
      if (Number.isSafeInteger(cursorMs) && cursorMs > 0) {
        const lagMs = Math.max(0, Date.now() - cursorMs)
        if (lagMs > CATCH_UP_THRESHOLD_MS) {
          nextDelay = CATCH_UP_INTERVAL_MS
          wasCatchingUp = true
          console.info('BINANCE USDT CATCHUP:', {
            cursor_kh: new Date(cursorMs).toLocaleString('en-GB', { timeZone: 'Asia/Bangkok', hour12: false }),
            minutes_behind: Math.ceil(lagMs / 60000),
            next_check_seconds: CATCH_UP_INTERVAL_MS / 1000,
          })
        } else if (wasCatchingUp) {
          wasCatchingUp = false
          console.info('BINANCE USDT CATCHUP COMPLETE: returning to the 10-minute interval')
        }
      }
    } catch (error) {
      failures = Math.min(failures + 1, 4)
      nextDelay = Math.min(MAX_RETRY_INTERVAL_MS, POLL_INTERVAL_MS * 2 ** (failures - 1))
      console.error('BINANCE USDT ALERT WORKER:', safeError(error))
    } finally {
      schedule(nextDelay)
    }
  }, Math.max(0, delayMs))

  timer.unref?.()
}

export function startBinanceUsdtAlertWorker() {
  if (started) return false
  if (process.env.BINANCE_USDT_ALERT_ENABLED !== 'true') {
    console.info('BINANCE USDT HISTORY WORKER DISABLED: BINANCE_USDT_ALERT_ENABLED is not true')
    return false
  }
  if (!hasBinanceApiCredentials()) {
    console.error('BINANCE USDT HISTORY WORKER DISABLED: Binance API credentials are missing')
    return false
  }

  started = true
  console.info('BINANCE USDT HISTORY WORKER STARTED: receipt ingestion enabled')
  if (!isTelegramDeliveryEnabled()) {
    console.warn('BINANCE USDT TELEGRAM ALERTS DISABLED: history receipts will still be recorded')
  }
  schedule(3000)
  return true
}

export function stopBinanceUsdtAlertWorker() {
  if (!started) return false
  started = false
  if (timer) clearTimeout(timer)
  timer = null
  wasCatchingUp = false
  return true
}
