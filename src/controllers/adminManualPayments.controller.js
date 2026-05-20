import { supabase } from '../config/supabase.js'

function normalizeStatus(status) {
  const value = String(status || '').trim().toLowerCase()
  if (value === 'approved') return 'success'
  if (value === 'confirmed') return 'success'
  if (value === 'pending') return 'waiting_payment'
  if (value === 'created') return 'waiting_payment'
  return value || 'waiting_payment'
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

function publicManualPayment(payment, userMap = {}) {
  const user = userMap[payment.user_id] || null
  return {
    id: payment.id,
    user_id: payment.user_id,
    order_id: payment.order_id || '',
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

export async function getAdminManualPayments(req, res) {
  try {
    const status = String(req.query.status || 'pending_review').trim()
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 200)

    let query = supabase
      .from('payment_transactions')
      .select('*')
      .eq('payment_method', 'aba_payment_link')
      .order('created_at', { ascending: false })
      .limit(limit)

    query = applyStatusFilter(query, status)

    const { data, error } = await query
    if (error) throw error

    const userMap = await getUsersMap((data || []).map((item) => item.user_id))
    const payments = (data || []).map((item) => publicManualPayment(item, userMap))

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

    const { data, error } = await supabase.rpc('admin_release_manual_payment', {
      p_payment_id: paymentId,
      p_admin_id: getAdminId(req),
      p_admin_note: adminNote || null,
    })

    if (error) throw error

    const payment = Array.isArray(data) ? data[0] : data
    const userMap = await getUsersMap([payment?.user_id])

    return res.status(200).json({ ok: true, payment: publicManualPayment(payment, userMap) })
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

    const userMap = await getUsersMap([data.user_id])
    return res.status(200).json({ ok: true, payment: publicManualPayment(data, userMap) })
  } catch (error) {
    console.error('REJECT ADMIN MANUAL PAYMENT ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to reject manual payment', error: error.message })
  }
}
