import { supabase } from '../config/supabase.js'
import { cleanupOldAdminActivityLogs } from '../services/adminActivity.service.js'

function toNumber(value, fallback = 1) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function normalizeAction(value) {
  return String(value || '').trim().toUpperCase()
}

function normalizeText(value) {
  return String(value || '').trim()
}

function publicActivityLog(record) {
  return {
    id: `activity:${record.id}`,
    source: 'activity',
    action: record.action || 'LOG',
    section_key: record.section_key || 'system',
    actor: record.actor || 'Admin',
    slide_title: record.slide_title || 'System activity',
    order_index: record.order_index,
    details: record.details || '',
    created_at: record.created_at,
  }
}

function paymentAction(payment) {
  const status = String(payment.status || '').toLowerCase()
  const match = String(payment.match_status || '').toLowerCase()

  if (status === 'success' && match === 'auto_released') return 'PAYMENT_AUTO'
  if (status === 'success') return 'PAYMENT_APPROVE'
  if (status === 'rejected') return 'PAYMENT_REJECT'
  if (status === 'pending_review') return 'PAYMENT_REVIEW'
  if (status === 'expired') return 'PAYMENT_EXPIRE'
  return 'PAYMENT'
}

function publicPaymentLog(payment) {
  const action = paymentAction(payment)
  const userLabel = payment.user?.username ? `@${payment.user.username}` : payment.user?.email || payment.user_id || 'Reader'
  const amount = `$${Number(payment.amount_usd || payment.package_usd || 0).toFixed(2)}`
  const diamonds = Number(payment.diamonds || 0).toLocaleString()
  const reason = payment.match_reason || payment.admin_note || 'Payment record updated.'
  const trx = payment.aba_trx_id ? ` Trx: ${payment.aba_trx_id}.` : ''

  return {
    id: `payment:${payment.id}`,
    source: 'payment',
    action,
    section_key: 'payment',
    actor: action === 'PAYMENT_AUTO' ? 'Shadow Bot' : 'Admin',
    slide_title: `Payment ${payment.order_id || payment.id}`,
    order_index: null,
    details: `${userLabel} · ${amount} · ${diamonds} Diamonds. ${reason}.${trx}`,
    created_at: payment.released_at || payment.confirmed_at || payment.rejected_at || payment.updated_at || payment.created_at,
  }
}

function matchesSearch(record, search) {
  if (!search) return true
  const q = search.toLowerCase()
  return [
    record.action,
    record.section_key,
    record.actor,
    record.slide_title,
    record.details,
    record.source,
  ].filter(Boolean).join(' ').toLowerCase().includes(q)
}

function matchesAction(record, action) {
  if (!action || action === 'ALL') return true
  if (action === 'PAYMENT') return String(record.action || '').startsWith('PAYMENT')
  if (action === 'GENRE') return record.section_key === 'genres' || record.section_key === 'featured_genre_tabs'
  if (action === 'COMMENT') return record.section_key === 'comments'
  return normalizeAction(record.action) === action
}

export async function getAdminActivityLogs(req, res) {
  try {
    await cleanupOldAdminActivityLogs()

    const page = Math.max(toNumber(req.query.page, 1), 1)
    const limit = Math.min(Math.max(toNumber(req.query.limit, 20), 1), 50)
    const action = normalizeAction(req.query.action || 'ALL')
    const search = normalizeText(req.query.search || req.query.q)
    const source = normalizeText(req.query.source || 'all').toLowerCase()

    const { data: rawLogs, error: rawLogsError } = await supabase
      .from('admin_activity_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(300)

    if (rawLogsError) throw rawLogsError

    const { data: payments, error: paymentsError } = await supabase
      .from('payment_transactions')
      .select('*, user:users(id, username, email, name)')
      .eq('payment_method', 'aba_payment_link')
      .order('created_at', { ascending: false })
      .limit(300)

    if (paymentsError) throw paymentsError

    let records = [
      ...(rawLogs || []).map(publicActivityLog),
      ...(payments || []).map(publicPaymentLog),
    ]

    if (source !== 'all') records = records.filter((record) => record.source === source || record.section_key === source)
    records = records.filter((record) => matchesAction(record, action))
    records = records.filter((record) => matchesSearch(record, search))
    records = records.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())

    const total = records.length
    const totalPages = Math.max(Math.ceil(total / limit), 1)
    const from = (page - 1) * limit
    const paged = records.slice(from, from + limit)

    return res.status(200).json({
      ok: true,
      records: paged,
      logs: paged,
      page,
      limit,
      total,
      total_pages: totalPages,
      totalPages,
    })
  } catch (error) {
    console.error('GET ADMIN ACTIVITY LOGS ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load admin activity logs',
      error: error.message,
    })
  }
}
