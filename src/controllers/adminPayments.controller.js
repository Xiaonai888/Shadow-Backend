import { supabase } from '../config/supabase.js'

function normalizeStatus(status) {
  const value = String(status || '').trim().toLowerCase()

  if (value === 'approved') return 'success'
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

function publicPayment(payment, userMap = {}) {
  const user = userMap[payment.user_id] || null

  return {
    id: payment.id,
    user_id: payment.user_id,
    order_id: payment.order_id || '',
    tran_id: payment.tran_id || payment.order_id || '',
    aba_transaction_id: payment.aba_transaction_id || payment.transaction_id || '',
    transaction_id: payment.transaction_id || payment.aba_transaction_id || '',
    bank_ref: payment.bank_ref || '',
    apv: payment.apv || '',
    package_usd: Number(payment.package_usd || payment.amount_usd || 0),
    amount_usd: Number(payment.amount_usd || payment.package_usd || 0),
    payment_amount: Number(payment.payment_amount || payment.amount_usd || payment.package_usd || 0),
    payment_currency: payment.payment_currency || payment.currency || 'USD',
    diamonds: Number(payment.diamonds || 0),
    bonus_gems: Number(payment.bonus_gems || 0),
    payment_method: payment.payment_method || 'aba_khqr',
    status: normalizeStatus(payment.status),
    created_at: payment.created_at,
    expired_at: payment.expired_at,
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

  if (value === 'success') return query.in('status', ['success', 'approved'])
  if (value === 'waiting_payment') return query.in('status', ['waiting_payment', 'pending', 'created'])
  if (value === 'failed') return query.eq('status', 'failed')
  if (value === 'expired') return query.eq('status', 'expired')
  if (value === 'cancelled') return query.eq('status', 'cancelled')
  if (value === 'callback_received') return query.eq('status', 'callback_received')

  return query.eq('status', value)
}

export async function getAdminPayments(req, res) {
  try {
    const status = String(req.query.status || 'success').trim()
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 200)

    let query = supabase
      .from('payment_transactions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit)

    query = applyStatusFilter(query, status)

    const { data, error } = await query

    if (error) throw error

    const userMap = await getUsersMap((data || []).map((item) => item.user_id))
    const payments = (data || []).map((item) => publicPayment(item, userMap))

    return res.status(200).json({
      ok: true,
      payments,
      purchases: payments,
    })
  } catch (error) {
    console.error('GET ADMIN PAYMENTS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load payments',
      error: error.message,
    })
  }
}

export async function getAdminPayment(req, res) {
  try {
    const paymentId = String(req.params.paymentId || '').trim()

    const { data, error } = await supabase
      .from('payment_transactions')
      .select('*')
      .or(`id.eq.${paymentId},order_id.eq.${paymentId},tran_id.eq.${paymentId}`)
      .maybeSingle()

    if (error) throw error
    if (!data) return res.status(404).json({ ok: false, message: 'Payment not found' })

    const userMap = await getUsersMap([data.user_id])

    return res.status(200).json({
      ok: true,
      payment: publicPayment(data, userMap),
    })
  } catch (error) {
    console.error('GET ADMIN PAYMENT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load payment',
      error: error.message,
    })
  }
}
