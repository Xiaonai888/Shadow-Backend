import { supabase } from '../config/supabase.js'
import { replyTelegram } from './telegram.service.js'

const POLL_MS = 2 * 60 * 1000
const MIN_RETRY_MS = 2 * 60 * 1000
const MAX_RETRY_MS = 60 * 60 * 1000
const SCAN_LIMIT = 30
const SEND_LIMIT = 5

let started = false
let running = false

function retryDue(row, now) {
  const last = Date.parse(String(row.report_last_attempt_at || ''))
  if (!Number.isFinite(last)) return true
  const attempts = Math.max(1, Number(row.report_attempts) || 1)
  const wait = Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** Math.min(attempts - 1, 6))
  return now >= last + wait
}

function safeError(error) {
  return String(error?.message || error || 'Telegram report failed')
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

  // If saving confirmation fails, keep this report PENDING rather than risk resending it.
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

export async function recoverMissingTelegramReports() {
  if (running || !process.env.TELEGRAM_BOT_TOKEN) return
  running = true

  try {
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
