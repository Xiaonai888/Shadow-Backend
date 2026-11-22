import { supabase } from '../config/supabase.js'
import { replyTelegram, sendTelegramMessage, sendAuthorStoreTelegramMessage, html } from './telegram.service.js'
import { buildAuthorStoreAttributionReportLines } from '../controllers/authorStore.controller.js'

const POLL_MS = 2 * 60 * 1000
const MIN_RETRY_MS = 2 * 60 * 1000
const MAX_RETRY_MS = 60 * 60 * 1000
const SCAN_LIMIT = 30
const SEND_LIMIT = 5
const PDF_SCAN_INTERVAL_MS = 5 * 60 * 1000
const PDF_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
const PDF_SCAN_LIMIT = 20
const PDF_SEND_LIMIT = 3
const PDF_MAX_ATTEMPTS = 8

let started = false
let running = false
let lastPdfScanAt = 0

function retryDue(row, now) {
  const last = Date.parse(String(row.report_last_attempt_at || ''))
  if (!Number.isFinite(last)) return true
  const attempts = Math.max(1, Number(row.report_attempts) || 1)
  const wait = Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** Math.min(attempts - 1, 6))
  return now >= last + wait
}


function safeError(error) {
  const details = [
    error?.message || String(error || 'Telegram report failed')
  ]
  const causes = [
    error?.cause,
    ...(Array.isArray(error?.cause?.errors)
      ? error.cause.errors.slice(0, 3)
      : [])
  ]

  for (const cause of causes) {
    if (!cause) continue
    details.push([
      cause.message || String(cause),
      cause.code && `code=${cause.code}`,
      cause.errno && `errno=${cause.errno}`,
      cause.syscall && `syscall=${cause.syscall}`
    ].filter(Boolean).join(' '))
  }

  return details.join(' | ')
    .replace(/[\r\n\t]/g, ' ')
    .slice(0, 1000)
}


async function claimFailedReport(row) {
  const attemptedAt = new Date().toISOString()
  const currentAttempts = Number(row.report_attempts || 0)
  const { data, error } = await supabase
    .from('telegram_payments')
    .update({
      report_status: 'pending',
      report_attempts: currentAttempts + 1,
      report_last_attempt_at: attemptedAt,
      report_last_error: null,
      updated_at: attemptedAt,
    })
    .eq('id', row.id)
    .eq('match_status', 'auto_released')
    .eq('report_status', 'failed')
    .eq('report_attempts', currentAttempts)
    .is('report_sent_at', null)
    .is('report_message_id', null)
    .select('id,report_attempts,telegram_chat_id,telegram_message_id,report_text')
    .maybeSingle()

  if (error) throw error
  return data
}

async function restoreFailedReport(row, error) {
  const { error: updateError } = await supabase
    .from('telegram_payments')
    .update({
      report_status: 'failed',
      report_last_error: safeError(error),
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id)
    .eq('report_status', 'pending')
    .eq('report_attempts', row.report_attempts)
    .is('report_sent_at', null)
    .is('report_message_id', null)

  if (updateError) throw updateError
}

async function deliverFailedReport(row) {
  const claim = await claimFailedReport(row)
  if (!claim) return false

  let response
  try {
    response = await replyTelegram(
      claim.telegram_chat_id,
      claim.telegram_message_id,
      claim.report_text
    )
    if (!response?.ok || response?.skipped || !response?.result?.message_id) {
      throw new Error('Telegram did not confirm report delivery')
    }
  } catch (sendError) {
    await restoreFailedReport(claim, sendError)
    console.warn('TELEGRAM MISSING REPORT SEND FAILED:', claim.id, safeError(sendError))
    return false
  }

  const sentAt = new Date().toISOString()
  const { data: saved, error: saveError } = await supabase
    .from('telegram_payments')
    .update({
      report_status: 'sent',
      report_last_error: null,
      report_sent_at: sentAt,
      report_message_id: String(response.result.message_id),
      updated_at: sentAt,
    })
    .eq('id', claim.id)
    .eq('report_status', 'pending')
    .eq('report_attempts', claim.report_attempts)
    .is('report_sent_at', null)
    .select('id')
    .maybeSingle()

  if (saveError || !saved) {
    console.error('TELEGRAM REPORT SENT BUT CONFIRMATION NOT SAVED:', claim.id, safeError(saveError || 'No matching pending report'))
    return false
  }

  console.info('TELEGRAM MISSING REPORT RECOVERED:', claim.id)
  return true
}

function pdfRetryDue(report, snapshot, now) {
  const count = Math.max(0, Number(report?.retry_attempts || 0))
  if (count >= PDF_MAX_ATTEMPTS) return false
  const last = Date.parse(String(report?.retry_attempted_at || snapshot?.attempted_at || ''))
  if (!Number.isFinite(last)) return true
  const wait = Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** Math.min(count, 6))
  return now >= last + wait
}

async function listFailedPdfReports(recipient, cutoff) {
  const { data, error } = await supabase
    .from('author_store_orders')
    .select('id,order_id,order_number,author_page_id,buyer_id,buyer_profile,buyer_name,buyer_phone,total_usd,total_amount,author_income_usd,aba_transaction_id,request_payload,payment_status,pdf_unlock_status,status,created_at,updated_at,items:author_store_order_items(*)')
    .eq('payment_status', 'paid')
    .eq('pdf_unlock_status', 'unlocked')
    .gte('created_at', cutoff)
    .contains('request_payload', { pdf_telegram_reports: { [recipient]: { status: 'failed' } } })
    .order('created_at', { ascending: true })
    .limit(PDF_SCAN_LIMIT)
  if (error) throw error
  return (data || []).map((row) => ({ ...row, recipient }))
}

function eligiblePdfReport(row, now) {
  const reports = row.request_payload?.pdf_telegram_reports
  const itemRows = Array.isArray(row.items) ? row.items : []
  const recipient = row.recipient
  const report = reports?.[recipient]
  if (report?.status !== 'failed' || !pdfRetryDue(report, reports, now)) return false
  if (!itemRows.length || !itemRows.every((item) => String(item.product_type || '').toLowerCase() === 'pdf')) return false
  if (recipient === 'author' && ['failed', 'sending'].includes(String(reports.admin?.status || ''))) return false
  return true
}

function pdfReportMessage(order, authorPage) {
  const buyer = order.buyer_profile || {}
  const money = (value) => `$${Number(value || 0).toFixed(2)}`
  const items = order.items || []
  return [
    '📄 <b>AUTHOR PDF SOLD</b>',
    '',
    `📄 Page: <b>${html(authorPage?.page_name || 'Author Page')}</b>`,
    authorPage?.page_username ? `🔗 Username: @${html(authorPage.page_username)}` : '',
    ...buildAuthorStoreAttributionReportLines(order, 'pdf'),
    '',
    `📦 Order ID: <code>${html(order.order_id || order.order_number || order.id)}</code>`,
    `💵 Amount: <b>${html(money(order.total_usd || order.total_amount))}</b>`,
    order.aba_transaction_id ? `🧾 Trx ID: <code>${html(order.aba_transaction_id)}</code>` : '',
    '',
    `👤 Buyer: <b>${html(buyer.name || order.buyer_name || order.buyer_id || 'Reader')}</b>`,
    buyer.phone_number || order.buyer_phone ? `📞 Phone: <code>${html(buyer.phone_number || order.buyer_phone)}</code>` : '',
    '',
    '<b>PDF:</b>',
    ...items.slice(0, 8).map((item) => `- ${html(item.product_title || item.title || 'PDF')} x${html(item.quantity || 1)}`),
    `💜 Author Income: <b>${html(money(order.author_income_usd))}</b>`,
    '',
    'Status: <b>Completed</b>',
    'PDF available in Reader Library Purchased.',
  ].filter(Boolean).join('\n')
}

async function claimPdfReport(row) {
  const recipient = row.recipient
  const attemptedAt = new Date().toISOString()
  const payload = row.request_payload
  const reports = payload?.pdf_telegram_reports || {}
  const current = reports[recipient] || {}
  const updated = {
    ...payload,
    pdf_telegram_reports: {
      ...reports,
      [recipient]: {
        ...current,
        status: 'sending',
        retry_attempts: Number(current.retry_attempts || 0) + 1,
        retry_attempted_at: attemptedAt,
        error: '',
      },
    },
  }
  const { data, error } = await supabase
    .from('author_store_orders')
    .update({ request_payload: updated, updated_at: attemptedAt })
    .eq('id', row.id)
    .eq('updated_at', row.updated_at)
    .eq('payment_status', 'paid')
    .eq('pdf_unlock_status', 'unlocked')
    .contains('request_payload', { pdf_telegram_reports: { [recipient]: { status: 'failed' } } })
    .select('id,request_payload,updated_at')
    .maybeSingle()
  if (error) throw error
  return data
}

async function finalizePdfReport(claim, recipient, status, result = {}) {
  const timestamp = new Date().toISOString()
  const snapshot = claim.request_payload?.pdf_telegram_reports || {}
  const current = snapshot[recipient] || {}
  const nextReport = {
    ...current,
    status,
    error: result.error || '',
    ...(status === 'sent' ? {
      sent_at: timestamp,
      message_id: String(result.message_id || ''),
    } : {}),
  }
  const changes = {
    request_payload: {
      ...claim.request_payload,
      pdf_telegram_reports: { ...snapshot, [recipient]: nextReport },
    },
    updated_at: timestamp,
  }
  if (recipient === 'author') {
    changes.telegram_status = status === 'sent' ? 'sent' : 'failed'
    changes.telegram_sent_at = status === 'sent' ? timestamp : null
    changes.telegram_error = status === 'sent' ? '' : (result.error || 'Telegram delivery needs review.')
  }
  const { data, error } = await supabase
    .from('author_store_orders')
    .update(changes)
    .eq('id', claim.id)
    .eq('updated_at', claim.updated_at)
    .contains('request_payload', { pdf_telegram_reports: { [recipient]: { status: 'sending' } } })
    .select('id')
    .maybeSingle()
  if (error || !data) {
    console.error('AUTHOR PDF TELEGRAM RETRY RESULT UNSAVED:', claim.id, recipient, safeError(error || 'Row was updated concurrently'))
    return false
  }
  return true
}

async function retrySinglePdfReport(row) {
  const adminChatId = process.env.TELEGRAM_AUTHOR_STORE_ADMIN_CHAT_ID || process.env.TELEGRAM_AUTHOR_STORE_CHAT_ID || process.env.TELEGRAM_ADMIN_CHAT_ID
  const { data: authorPage, error: authorPageError } = await supabase
    .from('author_pages')
    .select('page_name,page_username,telegram_chat_id')
    .eq('id', row.author_page_id)
    .maybeSingle()
  if (authorPageError) throw authorPageError
  const recipient = row.recipient
  const chatId = recipient === 'admin' ? adminChatId : authorPage?.telegram_chat_id
  const tokenAvailable = recipient === 'admin' ? process.env.TELEGRAM_BOT_TOKEN : process.env.TELEGRAM_AUTHOR_STORE_BOT_TOKEN
  if (!chatId || !tokenAvailable) return false

  const message = pdfReportMessage(row, authorPage)
  const claim = await claimPdfReport(row)
  if (!claim) return false
  try {
    const send = recipient === 'admin' ? sendTelegramMessage : sendAuthorStoreTelegramMessage
    const response = await send(message, { chat_id: String(chatId) })
    if (response?.ok !== true || !response?.result?.message_id) {
      throw new Error('Telegram did not confirm delivery')
    }
    const saved = await finalizePdfReport(claim, recipient, 'sent', { message_id: response.result.message_id })
    if (saved) console.info('AUTHOR PDF TELEGRAM REPORT RECOVERED:', row.order_id, recipient)
    return saved
  } catch (error) {
    await finalizePdfReport(claim, recipient, 'review_required', { error: safeError(error) })
    console.error('AUTHOR PDF TELEGRAM RETRY NEEDS REVIEW:', row.order_id, recipient, safeError(error))
    return false
  }
}

async function recoverFailedAuthorPdfReports() {
  if (Date.now() - lastPdfScanAt < PDF_SCAN_INTERVAL_MS) return
  lastPdfScanAt = Date.now()
  const cutoff = new Date(Date.now() - PDF_LOOKBACK_MS).toISOString()
  try {
    const [adminRows, authorRows] = await Promise.all([
      listFailedPdfReports('admin', cutoff),
      listFailedPdfReports('author', cutoff),
    ])
    const selected = new Map()
    for (const row of [...adminRows, ...authorRows]) {
      if (!selected.has(row.id)) selected.set(row.id, row)
    }
    let attempts = 0
    for (const row of selected.values()) {
      if (attempts >= PDF_SEND_LIMIT) break
      if (!eligiblePdfReport(row, Date.now())) continue
      attempts += 1
      try {
        await retrySinglePdfReport(row)
      } catch (error) {
        console.error('AUTHOR PDF TELEGRAM RECOVERY ERROR:', row.order_id, safeError(error))
      }
    }
  } catch (error) {
    console.error('AUTHOR PDF TELEGRAM REPORT SCAN ERROR:', safeError(error))
  }
}

export async function recoverMissingTelegramReports() {
  if (running || !process.env.TELEGRAM_BOT_TOKEN) return
  running = true

  try {
    await recoverFailedAuthorPdfReports()
    const { data: reports, error: listError } = await supabase
      .from('telegram_payments')
      .select('id,matched_payment_id,matched_user_id,report_text,report_attempts,report_last_attempt_at,telegram_chat_id,telegram_message_id')
      .eq('match_status', 'auto_released')
      .eq('report_status', 'failed')
      .is('report_sent_at', null)
      .is('report_message_id', null)
      .not('matched_payment_id', 'is', null)
      .not('report_text', 'is', null)
      .order('report_last_attempt_at', { ascending: true, nullsFirst: true })
      .limit(SCAN_LIMIT)

    if (listError) throw listError
    const dueReports = (reports || []).filter((row) =>
      row.report_text &&
      row.telegram_chat_id &&
      row.telegram_message_id &&
      retryDue(row, Date.now())
    )
    if (!dueReports.length) return

    const ids = [...new Set(dueReports.map((row) => row.matched_payment_id))]
    const { data: payments, error: paymentError } = await supabase
      .from('payment_transactions')
      .select('id,user_id,status,released_at,telegram_payment_id')
      .in('id', ids)
      .eq('status', 'success')
      .not('released_at', 'is', null)
      .limit(SCAN_LIMIT)

    if (paymentError) throw paymentError
    const byId = new Map((payments || []).map((payment) => [payment.id, payment]))

    let attemptsThisRun = 0
    for (const report of dueReports) {
      if (attemptsThisRun >= SEND_LIMIT) break
      const payment = byId.get(report.matched_payment_id)
      if (!payment) continue
      if (report.matched_user_id && String(report.matched_user_id) !== String(payment.user_id)) continue
      if (payment.telegram_payment_id && String(payment.telegram_payment_id) !== String(report.id)) continue

      attemptsThisRun += 1
      await deliverFailedReport(report)
    }
  } catch (error) {
    console.error('TELEGRAM MISSING REPORT RECOVERY ERROR:', safeError(error))
  } finally {
    running = false
  }
}

export function startTelegramMissingReportRecovery() {
  if (started) return
  started = true
  const timer = setInterval(() => {
    void recoverMissingTelegramReports()
  }, POLL_MS)
  timer.unref?.()
  void recoverMissingTelegramReports()
}
