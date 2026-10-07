import { supabase } from '../config/supabase.js'
import { publishPaymentStatus } from '../services/paymentEvents.service.js'
import { replyTelegram } from '../services/telegram.service.js'

function normalizeStatus(status) {
  const value = String(status || '').trim().toLowerCase()
  if (value === 'approved') return 'success'
  if (value === 'confirmed') return 'success'
  if (value === 'pending') return 'waiting_payment'
  if (value === 'created') return 'waiting_payment'
  return value || 'waiting_payment'
}

function isPremiumPayment(payment) {
  return (
    String(payment?.purchase_type || '').trim().toLowerCase() === 'premium' ||
    String(payment?.payment_method || '').trim().toLowerCase() === 'premium_aba_payment_link'
  )
}

function publicUser(user) {
  if (!user) return null
  return {
    id: user.id,
    name: user.name || '',
    username: user.username || '',
    email: user.email || '',
    avatar_url: user.avatar_url || '',
  }
}

function publicTelegramReport(report) {
  if (!report) return null
  return {
    id: report.id,
    trx_id: report.trx_id || '',
    title: report.report_title || '',
    text: report.report_text || '',
    status: report.report_status || '',
    attempts: Number(report.report_attempts || 0),
    last_error: report.report_last_error || '',
    last_attempt_at: report.report_last_attempt_at || null,
    sent_at: report.report_sent_at || null,
    message_id: report.report_message_id || '',
    admin_seen_at: report.admin_seen_at || null,
    updated_at: report.updated_at || null,
  }
}

function publicManualPayment(payment, userMap = {}, reportMap = {}) {
  const user = userMap[payment.user_id] || null
  const telegramReport = reportMap[payment.id] || null
  return {
    id: payment.id,
    user_id: payment.user_id,
    order_id: payment.order_id || '',
    purchase_type: payment.purchase_type || 'diamonds',
    premium_plan_months: Number(payment.premium_plan_months || 0),
    premium_base_diamonds: Number(payment.premium_base_diamonds || 0),
    premium_bonus_diamonds: Number(payment.premium_bonus_diamonds || 0),
    package_usd: Number(payment.package_usd || payment.amount_usd || 0),
    amount_usd: Number(payment.amount_usd || payment.package_usd || 0),
    payment_amount: Number(payment.payment_amount || payment.amount_usd || payment.package_usd || 0),
    payment_currency: payment.payment_currency || payment.currency || 'USD',
    diamonds: Number(payment.diamonds || 0),
    bonus_gems: Number(payment.bonus_gems || 0),
    payment_method: payment.payment_method || 'aba_payment_link',
    status: normalizeStatus(payment.status),
    checkout_url: payment.checkout_url || '',
    proof_image_url: payment.proof_image_url || '',
    proof_note: payment.proof_note || '',
    manual_reference: payment.manual_reference || '',
    admin_note: payment.admin_note || '',
    aba_trx_id: payment.aba_trx_id || '',
    aba_apv: payment.aba_apv || '',
    payer_name: payment.payer_name || '',
    match_status: payment.match_status || '',
    match_reason: payment.match_reason || '',
    created_at: payment.created_at,
    expires_at: payment.expires_at,
    expired_at: payment.expired_at,
    proof_expires_at: payment.proof_expires_at,
    proof_uploaded_at: payment.proof_uploaded_at,
    confirmed_at: payment.confirmed_at,
    rejected_at: payment.rejected_at,
    paid_at: payment.paid_at,
    released_at: payment.released_at,
    updated_at: payment.updated_at,
    user: publicUser(user),
    telegram_report: publicTelegramReport(telegramReport),
  }
}

async function getUsersMap(userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))]
  if (!ids.length) return {}

  const { data, error } = await supabase
    .from('users')
    .select('id, name, username, email, avatar_url')
    .in('id', ids)

  if (error) throw error
  return Object.fromEntries((data || []).map((user) => [user.id, user]))
}

async function getTelegramReportsMap(paymentIds) {
  const ids = [...new Set((paymentIds || []).filter(Boolean))]
  if (!ids.length) return {}

  const { data, error } = await supabase
    .from('telegram_payments')
    .select('id, matched_payment_id, trx_id, report_title, report_text, report_status, report_attempts, report_last_error, report_last_attempt_at, report_sent_at, report_message_id, admin_seen_at, updated_at')
    .in('matched_payment_id', ids)

  if (error) throw error

  return Object.fromEntries(
    (data || [])
      .filter((item) => item.matched_payment_id)
      .map((item) => [item.matched_payment_id, item])
  )
}

function applyStatusFilter(query, status) {
  const value = normalizeStatus(status)
  if (!status || value === 'all') return query
  if (value === 'success') return query.in('status', ['success', 'approved', 'confirmed'])
  if (value === 'waiting_payment') return query.in('status', ['waiting_payment', 'pending', 'created'])
  if (value === 'pending_review') return query.eq('status', 'pending_review')
  if (value === 'rejected') return query.eq('status', 'rejected')
  if (value === 'expired') return query.eq('status', 'expired')
  if (value === 'cancelled') return query.eq('status', 'cancelled')
  return query.eq('status', value)
}

function getAdminId(req) {
  return String(req.admin?.id || req.admin?.admin_id || req.admin?.email || req.admin?.username || 'admin')
}

async function getPaymentById(paymentId) {
  const { data, error } = await supabase
    .from('payment_transactions')
    .select('*')
    .eq('id', paymentId)
    .maybeSingle()

  if (error) throw error
  return data || null
}

async function getTelegramReportByPaymentId(paymentId) {
  const { data, error } = await supabase
    .from('telegram_payments')
    .select('*')
    .eq('matched_payment_id', paymentId)
    .maybeSingle()

  if (error) throw error
  return data || null
}

async function releasePremiumPaymentByAdmin(payment, req, adminNote) {
  const { data, error } = await supabase.rpc('release_premium_payment_from_telegram', {
    p_payment_id: payment.id,
    p_telegram_payment_id: payment.telegram_payment_id || null,
    p_trx_id: payment.aba_trx_id || '',
    p_apv: payment.aba_apv || null,
    p_payer_name: payment.payer_name || null,
  })

  if (error) throw error

  const released = Array.isArray(data) ? data[0] : data
  if (!released) return null

  const { data: reviewed, error: reviewError } = await supabase
    .from('payment_transactions')
    .update({
      admin_reviewed_by: getAdminId(req),
      admin_reviewed_at: new Date().toISOString(),
      admin_note: adminNote || null,
      match_reason: adminNote || 'Premium payment approved by admin.',
      updated_at: new Date().toISOString(),
    })
    .eq('id', released.id)
    .select('*')
    .single()

  if (reviewError) throw reviewError
  return reviewed
}

export async function getAdminManualPayments(req, res) {
  try {
    const status = String(req.query.status || 'pending_review').trim()
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 200)

    let query = supabase
      .from('payment_transactions')
      .select('*')
      .in('payment_method', ['aba_payment_link', 'premium_aba_payment_link'])
      .order('created_at', { ascending: false })
      .limit(limit)

    query = applyStatusFilter(query, status)

    const { data, error } = await query
    if (error) throw error

    const rows = data || []
    const [userMap, reportMap] = await Promise.all([
      getUsersMap(rows.map((item) => item.user_id)),
      getTelegramReportsMap(rows.map((item) => item.id)),
    ])
    const payments = rows.map((item) => publicManualPayment(item, userMap, reportMap))

    return res.status(200).json({ ok: true, payments, purchases: payments })
  } catch (error) {
    console.error('GET ADMIN MANUAL PAYMENTS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load manual payments', error: error.message })
  }
}

export async function confirmAdminManualPayment(req, res) {
  try {
    const paymentId = String(req.params.paymentId || '').trim()
    const adminNote = String(req.body.admin_note || '').trim().slice(0, 500)

    if (!paymentId) return res.status(400).json({ ok: false, message: 'Payment ID is required' })

    const existing = await getPaymentById(paymentId)
    if (!existing) return res.status(404).json({ ok: false, message: 'Payment not found' })

    let payment = null

    if (isPremiumPayment(existing)) {
      payment = await releasePremiumPaymentByAdmin(existing, req, adminNote)
    } else {
      const { data, error } = await supabase.rpc('admin_release_manual_payment', {
        p_payment_id: paymentId,
        p_admin_id: getAdminId(req),
        p_admin_note: adminNote || null,
      })

      if (error) throw error
      payment = Array.isArray(data) ? data[0] : data
    }

    if (payment) publishPaymentStatus(payment)

    const [userMap, reportMap] = await Promise.all([
      getUsersMap([payment?.user_id]),
      getTelegramReportsMap([payment?.id]),
    ])

    return res.status(200).json({
      ok: true,
      payment: publicManualPayment(payment, userMap, reportMap),
    })
  } catch (error) {
    console.error('CONFIRM ADMIN MANUAL PAYMENT ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to confirm manual payment', error: error.message })
  }
}

export async function rejectAdminManualPayment(req, res) {
  try {
    const paymentId = String(req.params.paymentId || '').trim()
    const adminNote = String(req.body.admin_note || '').trim().slice(0, 500)

    if (!paymentId) return res.status(400).json({ ok: false, message: 'Payment ID is required' })

    const { data, error } = await supabase
      .from('payment_transactions')
      .update({
        status: 'rejected',
        admin_reviewed_by: getAdminId(req),
        admin_reviewed_at: new Date().toISOString(),
        admin_note: adminNote || null,
        match_status: 'rejected',
        match_reason: adminNote || 'Rejected by admin.',
        rejected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', paymentId)
      .in('status', ['waiting_payment', 'pending_review'])
      .select('*')
      .single()

    if (error) throw error

    if (data) publishPaymentStatus(data)

    const [userMap, reportMap] = await Promise.all([
      getUsersMap([data.user_id]),
      getTelegramReportsMap([data.id]),
    ])

    return res.status(200).json({
      ok: true,
      payment: publicManualPayment(data, userMap, reportMap),
    })
  } catch (error) {
    console.error('REJECT ADMIN MANUAL PAYMENT ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to reject manual payment', error: error.message })
  }
}


export async function retryAdminTelegramReport(req, res) {
  try {
    const paymentId = String(req.params.paymentId || '').trim()
    if (!paymentId) return res.status(400).json({ ok: false, message: 'Payment ID is required' })

    const payment = await getPaymentById(paymentId)
    if (!payment) return res.status(404).json({ ok: false, message: 'Payment not found' })

    const report = await getTelegramReportByPaymentId(paymentId)
    if (!report || !report.report_text) {
      return res.status(404).json({ ok: false, message: 'Telegram report not found' })
    }

    if (report.report_status === 'sent') {
      return res.status(409).json({ ok: false, message: 'Telegram report was already sent' })
    }

    if (report.report_status === 'pending') {
      return res.status(409).json({ ok: false, message: 'Telegram report is already pending' })
    }

    if (!report.telegram_chat_id || !report.telegram_message_id) {
      return res.status(400).json({ ok: false, message: 'Telegram reply target is missing' })
    }

    const now = new Date().toISOString()
    const { data: locked, error: lockError } = await supabase
      .from('telegram_payments')
      .update({
        report_status: 'pending',
        report_attempts: Number(report.report_attempts || 0) + 1,
        report_last_error: null,
        report_last_attempt_at: now,
        updated_at: now,
      })
      .eq('id', report.id)
      .eq('report_status', 'failed')
      .select('*')
      .maybeSingle()

    if (lockError) throw lockError
    if (!locked) {
      return res.status(409).json({ ok: false, message: 'Telegram report retry is already in progress' })
    }

    try {
      const response = await replyTelegram(
        locked.telegram_chat_id,
        locked.telegram_message_id,
        locked.report_text
      )

      if (!response?.ok || response?.skipped) {
        throw new Error(response?.description || 'Telegram report was not sent.')
      }

      const sentAt = new Date().toISOString()
      const { data: sent, error: sentError } = await supabase
        .from('telegram_payments')
        .update({
          report_status: 'sent',
          report_last_error: null,
          report_sent_at: sentAt,
          report_message_id: response?.result?.message_id
            ? String(response.result.message_id)
            : null,
          updated_at: sentAt,
        })
        .eq('id', locked.id)
        .select('*')
        .single()

      if (sentError) throw sentError

      return res.status(200).json({ ok: true, telegram_report: publicTelegramReport(sent) })
    } catch (error) {
      const failedAt = new Date().toISOString()
      const { data: failed, error: failedError } = await supabase
        .from('telegram_payments')
        .update({
          report_status: 'failed',
          report_last_error: String(error?.message || error || 'Telegram send failed').slice(0, 1000),
          updated_at: failedAt,
        })
        .eq('id', locked.id)
        .select('*')
        .single()

      if (failedError) throw failedError

      return res.status(502).json({
        ok: false,
        message: failed.report_last_error || 'Telegram report retry failed',
        telegram_report: publicTelegramReport(failed),
      })
    }
  } catch (error) {
    console.error('RETRY ADMIN TELEGRAM REPORT ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to retry Telegram report', error: error.message })
  }
}
