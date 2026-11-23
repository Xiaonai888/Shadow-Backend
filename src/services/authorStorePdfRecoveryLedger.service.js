import { supabase } from '../config/supabase.js'

const MAX_ATTEMPTS = 7
const LOCK_DURATION_MS = 3 * 60 * 1000

function message(error) {
  return String(error?.message || error || 'Unknown recovery error').slice(0, 350)
}

export async function getPdfRecoveryJob(orderId) {
  const { data, error } = await supabase
    .from('author_store_pdf_recovery_jobs')
    .select('*')
    .eq('order_id', orderId)
    .maybeSingle()
  if (error) throw error
  return data
}

export async function claimPdfRecoveryJob(order) {
  const now = new Date().toISOString()
  const { error: createError } = await supabase
    .from('author_store_pdf_recovery_jobs')
    .upsert({
      order_id: order.id,
      order_number: order.order_id,
      buyer_id: order.buyer_id,
    }, { onConflict: 'order_id', ignoreDuplicates: true })
  if (createError) throw createError

  const job = await getPdfRecoveryJob(order.id)
  if (!job || !['pending', 'running', 'review_required'].includes(job.status)) return null
  if (job.next_attempt_at && Date.parse(job.next_attempt_at) > Date.now()) return null
  if (job.locked_until && Date.parse(job.locked_until) > Date.now()) return null

  const { data, error } = await supabase
    .from('author_store_pdf_recovery_jobs')
    .update({
      status: 'running',
      attempts: Number(job.attempts) + 1,
      locked_until: new Date(Date.now() + LOCK_DURATION_MS).toISOString(),
      last_checked_at: now,
      updated_at: now,
    })
    .eq('order_id', order.id)
    .eq('attempts', Number(job.attempts))
    .in('status', ['pending', 'running', 'review_required'])
    .lte('next_attempt_at', now)
    .or(`locked_until.is.null,locked_until.lt.${now}`)
    .select('*')
    .maybeSingle()
  if (error) throw error
  return data
}

export async function completePdfRecoveryJob(job, state, errorText = '') {
  const successful = state === 'purchased'
  const attempts = Number(job.attempts)
  const terminal = !successful && attempts >= MAX_ATTEMPTS
  const status = successful ? 'completed' : terminal ? 'review_required' : 'pending'
  const delayMinutes = terminal ? 24 * 60 : Math.min(120, 2 ** Math.min(attempts, 6) * 3)
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('author_store_pdf_recovery_jobs')
    .update({
      status,
      locked_until: null,
      next_attempt_at: new Date(Date.now() + delayMinutes * 60 * 1000).toISOString(),
      last_result: state,
      last_error: errorText ? message(errorText) : null,
      last_checked_at: now,
      updated_at: now,
    })
    .eq('order_id', job.order_id)
    .eq('attempts', attempts)
    .eq('status', 'running')
    .select('*')
    .maybeSingle()
  if (error) throw error
  return data
}

export async function markPdfRecoveryJobComplete(orderId) {
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('author_store_pdf_recovery_jobs')
    .update({
      status: 'completed',
      locked_until: null,
      last_result: 'purchased',
      last_error: null,
      updated_at: now,
    })
    .eq('order_id', orderId)
  if (error) throw error
}

export async function recordPdfRecoveryAction({ order, source, state, error = '', admin = null, reason = '' }) {
  const { error: insertError } = await supabase
    .from('author_store_pdf_recovery_actions')
    .insert({
      order_id: order.id,
      order_number: order.order_id,
      buyer_id: order.buyer_id,
      source,
      result: String(state || 'failed').slice(0, 70),
      payment_status_before: String(order.payment_status || ''),
      pdf_status_before: String(order.pdf_unlock_status || ''),
      error_message: error ? message(error) : null,
      admin_id: admin?.id || null,
      admin_email: admin?.email || null,
      reason: reason || null,
    })
  if (insertError) throw insertError
}

export async function markPdfRecoveryAlertSent(orderId) {
  const { error } = await supabase
    .from('author_store_pdf_recovery_jobs')
    .update({ alert_sent_at: new Date().toISOString() })
    .eq('order_id', orderId)
    .is('alert_sent_at', null)
  if (error) throw error
}
