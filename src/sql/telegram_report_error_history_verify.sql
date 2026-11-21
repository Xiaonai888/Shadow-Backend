import { supabase } from '../config/supabase.js'

const TABLE = 'telegram_report_error_history'
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const CLEANUP_MS = 24 * 60 * 60 * 1000
let cleanupStarted = false
let cleanupRunning = false

function sanitize(value, maxLength = 1000) {
  return String(value ?? '')
    .replace(/bot\d+:[A-Za-z0-9_-]+/gi, 'bot[REDACTED]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/[\r\n\t]/g, ' ')
    .slice(0, maxLength)
}

export function describeTelegramReportError(error) {
  const causes = [
    error,
    error?.cause,
    ...(Array.isArray(error?.cause?.errors) ? error.cause.errors.slice(0, 3) : []),
  ]
  const details = causes.filter(Boolean).map((cause) => [
    cause?.message || String(cause),
    cause?.code ? `code=${cause.code}` : '',
    cause?.errno ? `errno=${cause.errno}` : '',
    cause?.syscall ? `syscall=${cause.syscall}` : '',
  ].filter(Boolean).join(' '))
  return sanitize(details.join(' | ') || 'Telegram report failed')
}

export async function recordTelegramReportError({ telegramPaymentId, attemptNo, stage, error }) {
  if (!telegramPaymentId) return false
  try {
    const { error: saveError } = await supabase.from(TABLE).insert({
      telegram_payment_id: telegramPaymentId,
      attempt_no: Math.max(1, Number(attemptNo) || 1),
      stage,
      error_message: describeTelegramReportError(error),
      error_code: sanitize(error?.cause?.code || error?.code || '', 100) || null,
    })
    if (saveError) throw saveError
    return true
  } catch (saveError) {
    console.warn('TELEGRAM REPORT ERROR HISTORY SAVE FAILED:', sanitize(saveError?.message))
    return false
  }
}

export async function resolveTelegramReportErrors({ telegramPaymentId, reportMessageId }) {
  if (!telegramPaymentId) return false
  try {
    const { error } = await supabase.from(TABLE)
      .update({
        resolved_at: new Date().toISOString(),
        resolution: 'sent',
        report_message_id: reportMessageId ? String(reportMessageId) : null,
      })
      .eq('telegram_payment_id', telegramPaymentId)
      .is('resolved_at', null)
    if (error) throw error
    return true
  } catch (error) {
    console.warn('TELEGRAM REPORT ERROR HISTORY RESOLVE FAILED:', sanitize(error?.message))
    return false
  }
}

export async function cleanupExpiredTelegramReportErrors() {
  if (cleanupRunning) return false
  cleanupRunning = true
  try {
    const cutoff = new Date(Date.now() - RETENTION_MS).toISOString()
    const { error } = await supabase.from(TABLE).delete().lt('created_at', cutoff)
    if (error) throw error
    return true
  } catch (error) {
    console.warn('TELEGRAM REPORT ERROR HISTORY CLEANUP FAILED:', sanitize(error?.message))
    return false
  } finally {
    cleanupRunning = false
  }
}

export function startTelegramReportErrorHistoryCleanup() {
  if (cleanupStarted) return
  cleanupStarted = true
  const timer = setInterval(() => {
    void cleanupExpiredTelegramReportErrors()
  }, CLEANUP_MS)
  timer.unref?.()
  void cleanupExpiredTelegramReportErrors()
}
