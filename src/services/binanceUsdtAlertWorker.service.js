import { supabase } from '../config/supabase.js'
import { fetchBinanceUsdtIncome } from './binanceUsdtPay.service.js'
import { html, sendTelegramMessage } from './telegram.service.js'

const POLL_INTERVAL_MS = 10 * 60 * 1000
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

function getAlertChatId() {
  const chatId = String(process.env.TELEGRAM_BINANCE_ALERT_CHAT_ID || '').trim()
  return /^-100\d{6,18}$/.test(chatId) ? chatId : ''
}

function isEnabled() {
  return process.env.BINANCE_USDT_ALERT_ENABLED === 'true'
    && Boolean(String(process.env.BINANCE_USDT_API_KEY || '').trim())
    && Boolean(String(process.env.BINANCE_USDT_API_SECRET || '').trim())
    && Boolean(String(process.env.TELEGRAM_BOT_TOKEN || '').trim())
    && Boolean(getAlertChatId())
}

function safeError(error) {
  const message = String(error?.message || 'Unknown error')
  return message.replace(/[\r\n\t]/g, ' ').slice(0, 300)
}

export function formatBinanceUsdtAlertMessage(row) {
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

  return [
    '💰 <b>Binance USDT Received</b>',
    `Amount: <b>${html(row?.amount)} USDT</b>`,
    payer ? `From: ${html(payer)}` : null,
    orderType ? `Type: ${html(orderType)}` : null,
    `Transaction: <code>${html(row?.transaction_id)}</code>`,
    `Time: ${html(when)} (Cambodia)`,
  ].filter(Boolean).join('\n')
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

async function markAlertFailed(alert, reason) {
  const attempts = Math.max(1, Math.min(20, Number(alert.attempt_count) || 1))
  const retryAfterMs = Math.min(MAX_RETRY_INTERVAL_MS, 60_000 * 2 ** Math.min(attempts, 6))
  const { error } = await supabase
    .from('binance_usdt_alert_transactions')
    .update({
      delivery_status: 'failed',
      last_error: safeError(reason),
      next_attempt_at: new Date(Date.now() + retryAfterMs).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('transaction_id', alert.transaction_id)
    .eq('delivery_status', 'sending')

  if (error) throw error
}

async function deliverPendingAlerts() {
  const { data: alerts, error: claimError } = await supabase
    .rpc('claim_binance_usdt_alerts', { p_limit: MAX_DELIVERY_BATCH })

  if (claimError) throw claimError
  if (!Array.isArray(alerts) || alerts.length > MAX_DELIVERY_BATCH) {
    throw new Error('Invalid Binance USDT alert delivery batch')
  }

  let sent = 0

  for (const alert of alerts) {
    let messageId

    try {
      const delivered = await sendTelegramMessage(formatBinanceUsdtAlertMessage(alert), {
        chat_id: getAlertChatId(),
      })
      messageId = Number(delivered?.result?.message_id)
      if (delivered?.ok !== true || !Number.isSafeInteger(messageId) || messageId <= 0) {
        throw new Error('Binance USDT Telegram message was not accepted')
      }
    } catch (error) {
      await markAlertFailed(alert, error)
      continue
    }

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
    if (!saved) throw new Error('Binance USDT Telegram delivery was not recorded')
    sent += 1
  }

  return { sent, claimed: alerts.length }
}

export async function processBinanceUsdtAlertsOnce() {
  if (!isEnabled()) return { skipped: true }
  if (running) return { skipped: true, running: true }

  running = true
  let ingestError = null
  let deliveryError = null
  let ingest = null
  let delivery = null

  try {
    try {
      ingest = await ingestBinanceReceipts()
    } catch (error) {
      ingestError = error
    }

    try {
      delivery = await deliverPendingAlerts()
    } catch (error) {
      deliveryError = error
    }

    if (ingestError || deliveryError) {
      const failures = [
        ingestError ? `history: ${safeError(ingestError)}` : null,
        deliveryError ? `telegram: ${safeError(deliveryError)}` : null,
      ].filter(Boolean)
      throw new Error(failures.join('; '))
    }

    return { ingest, delivery }
  } finally {
    running = false
  }
}

function schedule(delayMs) {
  if (!started || !isEnabled()) return
  if (timer) clearTimeout(timer)

  timer = setTimeout(async () => {
    timer = null
    let nextDelay = POLL_INTERVAL_MS

    try {
      await processBinanceUsdtAlertsOnce()
      failures = 0
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
  if (started || !isEnabled()) return false
  started = true
  schedule(3000)
  return true
}

export function stopBinanceUsdtAlertWorker() {
  if (!started) return false
  started = false
  if (timer) clearTimeout(timer)
  timer = null
  return true
}
