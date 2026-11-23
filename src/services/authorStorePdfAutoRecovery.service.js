import { supabase } from '../config/supabase.js'
import { recheckAuthorStorePdfOrder } from './authorStorePdfPaymentRecovery.service.js'
import {
  claimPdfRecoveryJob,
  completePdfRecoveryJob,
  markPdfRecoveryAlertSent,
  markPdfRecoveryJobComplete,
  recordPdfRecoveryAction,
} from './authorStorePdfRecoveryLedger.service.js'
import { html, sendTelegramMessage } from './telegram.service.js'

const INTERVAL_MS = 10 * 60 * 1000
const MAX_CANDIDATES_PER_QUERY = 80
const MAX_RECOVERIES_PER_SCAN = 12
const RECOVERY_SCAN_PAGE_SIZE = 30
let running = false
let started = false
let recoveryScanOffset = 0

function validPdfOnlyOrder(order) {
  const items = Array.isArray(order?.items) ? order.items : []
  return Boolean(order?.id && order?.buyer_id && /^A[A-Z0-9]{8,19}$/.test(String(order?.order_id || '')))
    && items.length > 0
    && items.every((item) => String(item.product_type || '').toLowerCase() === 'pdf'
      && Number(item.quantity) === 1 && item.product_id)
}

function isSafelyEligible(order) {
  const status = String(order.status || '').toLowerCase()
  const paid = String(order.payment_status || '').toLowerCase()
  if (['refunded', 'rejected', 'cancelled', 'canceled', 'amount_mismatch', 'failed'].includes(status)) return false
  return paid === 'paid' &&
  (
    Boolean(order.missingGrant) ||
    String(order.pdf_unlock_status || '').toLowerCase() !== 'unlocked'
  )
}

async function getCandidates() {
  const paidCutoff = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString()
const fields = 'id,order_id,buyer_id,status,payment_status,pdf_unlock_status,created_at,expires_at,total_usd,items:author_store_order_items(product_id,product_type,quantity)'

const paid = await supabase
  .from('author_store_orders')
  .select(fields)
  .eq('payment_status', 'paid')
  .or('pdf_unlock_status.is.null,pdf_unlock_status.neq.unlocked')
  .gte('created_at', paidCutoff)
  .order('created_at', { ascending: false })
  .limit(MAX_CANDIDATES_PER_QUERY)

if (paid.error) throw paid.error
  const missingGrantResult = await supabase
    .from('author_store_pdf_recovery_index_v1')
    .select('id')
    .eq('delivery_status', 'needs_recovery')
    .order('created_at', { ascending: false })
    .range(
      recoveryScanOffset,
      recoveryScanOffset + RECOVERY_SCAN_PAGE_SIZE - 1
    )

  if (missingGrantResult.error) throw missingGrantResult.error

  recoveryScanOffset =
    (missingGrantResult.data || []).length < RECOVERY_SCAN_PAGE_SIZE
      ? 0
      : recoveryScanOffset + RECOVERY_SCAN_PAGE_SIZE
  const missingGrantIds = (missingGrantResult.data || []).map((row) => row.id).filter(Boolean)
  const missingGrantOrders = missingGrantIds.length
    ? await supabase.from('author_store_orders').select(fields).in('id', missingGrantIds)
    : { data: [], error: null }
  if (missingGrantOrders.error) throw missingGrantOrders.error
  const overdueResult = await supabase
    .from('author_store_pdf_recovery_jobs')
    .select('order_id')
    .eq('status', 'review_required')
    .lte('next_attempt_at', new Date().toISOString())
    .order('next_attempt_at', { ascending: true })
    .limit(12)
  if (overdueResult.error) throw overdueResult.error
  const overdueIds = (overdueResult.data || []).map((row) => row.order_id).filter(Boolean)
  const overdue = overdueIds.length
    ? await supabase.from('author_store_orders').select(fields).in('id', overdueIds)
    : { data: [], error: null }
  if (overdue.error) throw overdue.error
  const all = [
  ...(overdue.data || []),
  ...(paid.data || []),
  ...(missingGrantOrders.data || []).map((order) => ({ ...order, missingGrant: true })),
]
  const unique = new Map(all.filter(validPdfOnlyOrder).filter(isSafelyEligible)
    .map((order) => [String(order.id), order]))
  return [...unique.values()].sort((a, b) => {
    if (a.payment_status === 'paid' && b.payment_status !== 'paid') return -1
    if (a.payment_status !== 'paid' && b.payment_status === 'paid') return 1
    return Date.parse(a.created_at || '') - Date.parse(b.created_at || '')
  })
}

async function maybeAlertAdmin(order, job, result) {
  if (String(order.payment_status || '') !== 'paid' || result === 'purchased') return
  if (job.alert_sent_at) return
  const chatId = process.env.TELEGRAM_AUTHOR_STORE_ADMIN_CHAT_ID
    || process.env.TELEGRAM_AUTHOR_STORE_CHAT_ID
    || process.env.TELEGRAM_ADMIN_CHAT_ID
  if (!chatId || !process.env.TELEGRAM_BOT_TOKEN) return
  const text = [
    '⚠️ <b>PDF DELIVERY RECOVERY REQUIRED</b>',
    `Order: <code>${html(order.order_id)}</code>`,
    `Buyer: <code>${html(order.buyer_id)}</code>`,
    `Payment: <b>PAID</b>`,
    `PDF: <b>${html(result)}</b>`,
    'Review in Admin → PDF Recovery.',
  ].join('\n')
  try {
    const response = await sendTelegramMessage(text, { chat_id: chatId })
    if (response?.ok === true) await markPdfRecoveryAlertSent(order.id)
  } catch (error) {
    console.warn('AUTHOR PDF RECOVERY TELEGRAM ALERT FAILED:', order.order_id, String(error?.message || error).slice(0, 160))
  }
}

export async function attemptAuthorStorePdfRecovery(order, { source = 'auto', admin = null, reason = '' } = {}) {
  if (!validPdfOnlyOrder(order)) {
    const error = new Error('PDF recovery requires a valid PDF-only order')
    error.statusCode = 400
    throw error
  }
  let state = 'failed'
  let failure = ''
  try {
    const result = await recheckAuthorStorePdfOrder(String(order.buyer_id), String(order.order_id))
    state = String(result?.state || 'failed')
  } catch (error) {
    failure = String(error?.message || error).slice(0, 350)
    console.error('AUTHOR PDF RECOVERY ATTEMPT ERROR:', order.order_id, failure)
  }
  await recordPdfRecoveryAction({ order, source, state, error: failure, admin, reason })
  if (state === 'purchased' && source === 'admin') await markPdfRecoveryJobComplete(order.id)
  return { state, error: failure, order_id: order.order_id }
}

export async function runAuthorStorePdfRecoverySweep() {
  if (running) return { skipped: true, reason: 'already_running' }
  running = true
  const stats = { checked: 0, recovered: 0, review_required: 0, pending: 0, errors: 0 }
  
  try {
    const candidates = await getCandidates()
    for (const order of candidates) {
      if (stats.checked >= MAX_RECOVERIES_PER_SCAN) break
      let job
      try {
        job = await claimPdfRecoveryJob(order)
        if (!job) continue
        stats.checked += 1
        const result = await attemptAuthorStorePdfRecovery(order)
        const finished = await completePdfRecoveryJob(job, result.state, result.error)
        if (result.state === 'purchased') stats.recovered += 1
        else if (finished?.status === 'review_required') stats.review_required += 1
        else stats.pending += 1
        if (result.state !== 'purchased') await maybeAlertAdmin(order, finished || job, result.state)
      } catch (error) {
        stats.errors += 1
        console.error('AUTHOR PDF RECOVERY WORKER ITEM ERROR:', order.order_id, String(error?.message || error).slice(0, 250))
        if (job) {
          try {
            await completePdfRecoveryJob(job, 'failed', error.message || String(error))
          } catch (saveError) {
            console.error('AUTHOR PDF RECOVERY JOB FINALIZE ERROR:', String(saveError?.message || saveError).slice(0, 200))
          }
        }
      }
    }
    if (stats.checked || stats.errors) console.info('AUTHOR PDF RECOVERY SWEEP:', stats)
    return stats
  } catch (error) {
    console.error('AUTHOR PDF RECOVERY SWEEP FAILED:', String(error?.message || error).slice(0, 300))
    return { ...stats, error: 'recovery_sweep_failed' }
  } finally {
    running = false
  }
}

export function startAuthorStorePdfAutoRecovery() {
  if (started || process.env.AUTHOR_STORE_PDF_AUTO_RECOVERY_ENABLED !== 'true') return
  started = true
  const timer = setInterval(() => {
    void runAuthorStorePdfRecoverySweep()
  }, INTERVAL_MS)
  timer.unref?.()
  void runAuthorStorePdfRecoverySweep()
}
