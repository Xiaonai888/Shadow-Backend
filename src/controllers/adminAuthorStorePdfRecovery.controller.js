import { supabase } from '../config/supabase.js'
import { verifyAdminPasskeyPin } from '../services/adminPasskeyPin.service.js'
import { attemptAuthorStorePdfRecovery } from '../services/authorStorePdfAutoRecovery.service.js'

const ORDER_NUMBER = /^A[A-Z0-9]{8,19}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SEARCH_STATUSES = new Set(['all', 'paid', 'delivered', 'needs_recovery', 'waiting_payment', 'failed'])
const ORDER_FIELDS = 'id,order_id,buyer_id,buyer_name,buyer_phone,total_usd,currency,status,payment_status,pdf_unlock_status,created_at,expires_at,paid_at,aba_transaction_id,telegram_status,telegram_error,pdf_count,granted_count,delivery_status'

function adminIdentity(req) {
  const role = String(req.admin?.role || '').trim().toLowerCase()
  return {
    permitted: ['owner', 'admin'].includes(role),
    id: String(req.admin?.admin_id || req.admin?.id || req.admin?.email || '').trim(),
    email: String(req.admin?.email || '').trim().toLowerCase(),
  }
}

function safeText(value, max = 100) {
  return String(value || '').trim().slice(0, max)
}


function searchValue(raw) {
  return safeText(raw, 80).replace(/^@+/, '').replace(/[,()%*;"\\:]/g, ' ').trim()
}

const PDF_DATE_RANGE_MS = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}

function invalidPdfDateRange() {
  const error = new Error('Invalid PDF recovery date range')
  error.statusCode = 400
  throw error
}

function readPdfDateRange(raw = {}) {
  const range = safeText(raw.range || 'all', 20).toLowerCase()
  const now = Date.now()
  const khOffset = 7 * 60 * 60 * 1000

  if (range === 'all') return { range, from: '', to: '' }

  if (range === 'custom') {
    const from = safeText(raw.from, 50)
    const to = safeText(raw.to, 50)
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
    const start = Date.parse(from)
    const end = Date.parse(to)

    if (!iso.test(from) || !iso.test(to) || !Number.isFinite(start)
      || !Number.isFinite(end) || start >= end || end > now + 60000) {
      invalidPdfDateRange()
    }

    return {
      range,
      from: new Date(start).toISOString(),
      to: new Date(end).toISOString(),
    }
  }

  if (range === 'today' || range === 'month') {
    const kh = new Date(now + khOffset)
    const day = range === 'month' ? 1 : kh.getUTCDate()
    const start = Date.UTC(
      kh.getUTCFullYear(),
      kh.getUTCMonth(),
      day
    ) - khOffset

    return {
      range,
      from: new Date(start).toISOString(),
      to: new Date(now).toISOString(),
    }
  }

  if (!Object.prototype.hasOwnProperty.call(PDF_DATE_RANGE_MS, range)) {
    invalidPdfDateRange()
  }

  return {
    range,
    from: new Date(now - PDF_DATE_RANGE_MS[range]).toISOString(),
    to: new Date(now).toISOString(),
  }
}

function filterPdfCreatedAt(query, dateRange) {
  if (dateRange.from) query = query.gte('created_at', dateRange.from)
  if (dateRange.to) query = query.lte('created_at', dateRange.to)
  return query
}


function pdfItems(order) {
  return (Array.isArray(order?.items) ? order.items : []).filter((item) =>
    String(item.product_type || '').toLowerCase() === 'pdf' && item.product_id)
}

function publicOrder(order, users, grants) {
  const items = pdfItems(order)
  const grantedCount = items.filter((item) =>
    grants.has(`${order.buyer_id}:${item.product_id}`)).length
  const paid = String(order.payment_status || '').toLowerCase() === 'paid'
  const unlocked = String(order.pdf_unlock_status || '').toLowerCase() === 'unlocked'
  const delivered = paid && unlocked && items.length > 0 && grantedCount === items.length
  return {
    ...order,
    items,
    buyer: users.get(String(order.buyer_id)) || null,
    pdf_count: items.length,
    granted_count: grantedCount,
    delivery_status: delivered ? 'delivered' : paid ? 'needs_recovery' : 'not_paid',
  }
}

async function enrich(orders) {
  const buyers = [...new Set(orders.map((order) => order.buyer_id).filter(Boolean))]
  const products = [...new Set(orders.flatMap((order) => pdfItems(order).map((item) => item.product_id)))]
  const [usersResult, grantsResult] = await Promise.all([
    buyers.length ? supabase.from('users').select('id,name,username,email').in('id', buyers)
      : Promise.resolve({ data: [], error: null }),
    buyers.length && products.length
      ? supabase.from('author_store_reader_downloads').select('buyer_id,product_id')
        .in('buyer_id', buyers).in('product_id', products)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (usersResult.error) throw usersResult.error
  if (grantsResult.error) throw grantsResult.error
  const users = new Map((usersResult.data || []).map((user) => [String(user.id), user]))
  const grants = new Set((grantsResult.data || []).map((grant) => `${grant.buyer_id}:${grant.product_id}`))
  return orders.map((order) => publicOrder(order, users, grants))
}

async function readPdfOrder(publicId) {
  if (!ORDER_NUMBER.test(String(publicId || ''))) {
    const error = new Error('Invalid PDF order ID')
    error.statusCode = 400
    throw error
  }
  const { data, error } = await supabase
    .from('author_store_orders')
    .select('*,items:author_store_order_items(*)')
    .eq('order_id', publicId)
    .maybeSingle()
  if (error) throw error
  if (!data || !pdfItems(data).length) {
    const missing = new Error('PDF order not found')
    missing.statusCode = 404
    throw missing
  }
  return data
}

async function validatePasskey(req, res, purpose) {
  const admin = adminIdentity(req)
  if (!admin.permitted || !admin.id || !admin.email) {
    res.status(403).json({ ok: false, message: 'Owner or Admin account required' })
    return null
  }
  const pin = safeText(req.body?.passkey, 20)
  if (!/^\d{6}$/.test(pin)) {
    res.status(400).json({ ok: false, message: 'Enter the six-digit Admin Passkey' })
    return null
  }
  const result = await verifyAdminPasskeyPin({ admin: req.admin, req, pin, purpose })
  if (!result.ok) {
    res.status(result.status || 403).json({ ok: false, code: result.code || 'PASSKEY_FAILED', message: result.message })
    return null
  }
  return admin
}

function errorResponse(res, error) {
  console.error('ADMIN PDF RECOVERY ERROR:', String(error?.message || error).slice(0, 400))
  const status = [400, 404, 409].includes(error.statusCode) ? error.statusCode : 503
  return res.status(status).json({ ok: false, message: status === 503 ? 'PDF recovery is temporarily unavailable. No new payment was created.' : error.message })
}

export async function listAdminAuthorStorePdfRecovery(req, res) {
  try {
    const page = Math.min(Math.max(Number.parseInt(req.query.page, 10) || 1, 1), 100000)
    const status = safeText(req.query.status || 'all', 40).toLowerCase()
    const rawSearch = safeText(req.query.q, 80)
    const q = searchValue(rawSearch)
    if (!SEARCH_STATUSES.has(status) || (rawSearch && !q)) {
      return res.status(400).json({ ok: false, message: 'Invalid PDF recovery filter' })
    }

    const dateRange = readPdfDateRange(req.query)
    let query = supabase.from('author_store_pdf_recovery_index_v1').select(ORDER_FIELDS)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
    query = filterPdfCreatedAt(query, dateRange)


    if (q) {
      const [usersResult, itemResult] = await Promise.all([
        supabase.from('users').select('id').or(`name.ilike.%${q}%,username.ilike.%${q}%`).limit(40),
        supabase.from('author_store_order_items').select('order_id').ilike('product_title', `%${q}%`).limit(40),
      ])
      if (usersResult.error) throw usersResult.error
      if (itemResult.error) throw itemResult.error
      const buyerIds = [...new Set((usersResult.data || []).map((item) => item.id).filter(Boolean))]
      const orderIds = [...new Set((itemResult.data || []).map((item) => item.order_id).filter(Boolean))]
      const filters = [`order_id.ilike.%${q}%`, `buyer_name.ilike.%${q}%`, `aba_transaction_id.ilike.%${q}%`]
      if (UUID.test(q)) filters.push(`buyer_id.eq.${q}`)
      if (buyerIds.length) filters.push(`buyer_id.in.(${buyerIds.join(',')})`)
      if (orderIds.length) filters.push(`id.in.(${orderIds.join(',')})`)
      query = query.or(filters.join(','))
    }

    if (status === 'waiting_payment') query = query.eq('payment_status', 'pending')
    if (status === 'paid') query = query.eq('payment_status', 'paid')
    if (status === 'failed') query = query.eq('pdf_unlock_status', 'failed')
    if (status === 'needs_recovery') query = query.eq('delivery_status', 'needs_recovery')
    if (status === 'delivered') query = query.eq('delivery_status', 'delivered')

    const start = (page - 1) * 10
    const { data, error } = await query.range(start, start + 10)
    if (error) throw error
    const pageOrders = (data || []).slice(0, 10)
    const orderIds = pageOrders.map((order) => order.id)
    const pdfResult = orderIds.length
      ? await supabase.from('author_store_order_items')
        .select('order_id,product_id,product_title,product_type,quantity')
        .in('order_id', orderIds).eq('product_type', 'pdf')
      : { data: [], error: null }
    if (pdfResult.error) throw pdfResult.error
    const itemMap = new Map()
    for (const item of pdfResult.data || []) {
      const key = String(item.order_id)
      if (!itemMap.has(key)) itemMap.set(key, [])
      itemMap.get(key).push(item)
    }
    const items = await enrich(pageOrders.map((order) => ({
      ...order, items: itemMap.get(String(order.id)) || [],
    })))
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({
      ok: true, page, limit: 10, status, items,
      has_next: (data || []).length > 10,
      has_prev: page > 1,
    })
  } catch (error) {
    return errorResponse(res, error)
  }
}

export async function getAdminAuthorStorePdfRecoveryDetail(req, res) {
  try {
    const order = await readPdfOrder(req.params.orderId)
    const [enriched, actionsResult, manualResult] = await Promise.all([
      enrich([order]),
      supabase.from('author_store_pdf_recovery_actions').select('*')
        .eq('order_id', order.id).order('created_at', { ascending: false }).limit(30),
      supabase.from('author_store_pdf_manual_settlements')
        .select('bank_reference,verified_amount_usd,bank_paid_at,admin_email,reason,created_at')
        .eq('order_id', order.id).maybeSingle(),
    ])
    if (actionsResult.error) throw actionsResult.error
    if (manualResult.error) throw manualResult.error
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({
      ok: true, order: enriched[0],
      actions: actionsResult.data || [], manual_settlement: manualResult.data || null,
    })
  } catch (error) {
    return errorResponse(res, error)
  }
}

export async function listAdminAuthorStorePdfRecoveryHistory(req, res) {
  try {
    const page = Math.min(Math.max(Number.parseInt(req.query.page, 10) || 1, 1), 100000)

    const dateRange = readPdfDateRange(req.query)
    const start = (page - 1) * 10
    let query = supabase.from('author_store_pdf_recovery_actions').select('*')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
    query = filterPdfCreatedAt(query, dateRange)
    const { data, error } = await query.range(start, start + 10)

    if (error) throw error
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({ ok: true, page, limit: 10, items: (data || []).slice(0, 10), has_next: (data || []).length > 10 })
  } catch (error) {
    return errorResponse(res, error)
  }
}

export async function recoverAdminAuthorStorePdfOrder(req, res) {
  try {
    const order = await readPdfOrder(req.params.orderId)
    const reason = safeText(req.body?.reason, 500)
    if (reason.length < 12) return res.status(400).json({ ok: false, message: 'Explain the PDF recovery reason (at least 12 characters)' })
    if (req.body?.buyer_id && String(req.body.buyer_id) !== String(order.buyer_id)) {
      return res.status(409).json({ ok: false, message: 'Buyer account does not match the original order' })
    }
    const admin = await validatePasskey(req, res, `pdf_recover:${order.order_id}`)
    if (!admin) return
    const result = await attemptAuthorStorePdfRecovery(order, { source: 'admin', admin, reason })
    res.set('Cache-Control', 'no-store')
    return res.status(result.state === 'purchased' ? 200 : 202).json({ ok: true, ...result, no_new_payment: true })
  } catch (error) {
    return errorResponse(res, error)
  }
}

export async function manuallyConfirmAdminAuthorStorePdfPayment(req, res) {
  try {
    const order = await readPdfOrder(req.params.orderId)
    const reason = safeText(req.body?.reason, 500)
    const reference = safeText(req.body?.reference, 100)
    const amount = Number(req.body?.verified_amount_usd)
    const bankPaidAt = new Date(String(req.body?.bank_paid_at || ''))
    if (req.body?.bank_verified !== true || req.body?.confirm_recipient !== true) {
      return res.status(400).json({ ok: false, message: 'Confirm the bank settlement and the correct buyer' })
    }
    if (req.body?.buyer_id !== order.buyer_id || !UUID.test(String(req.body.buyer_id || ''))) {
      return res.status(409).json({ ok: false, message: 'Select the buyer from this original PDF order' })
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{5,99}$/.test(reference) ||
        !Number.isFinite(amount) || amount <= 0 ||
        Math.abs(amount - Number(order.total_usd)) > 0.009 ||
        Number.isNaN(bankPaidAt.getTime()) || bankPaidAt.getTime() > Date.now() + 5 * 60 * 1000 ||
        reason.length < 12 || reason.length > 500) {
      return res.status(400).json({ ok: false, message: 'Invalid bank reference, amount, payment time or reason' })
    }
    if (String(order.request_payload?.payment_method || '').toLowerCase().includes('binance')) {
      return res.status(409).json({ ok: false, message: 'Binance payment must be verified through the Binance workflow' })
    }
    const admin = await validatePasskey(req, res, `pdf_manual_payment:${order.order_id}`)
    if (!admin) return
    const { data, error } = await supabase.rpc('admin_author_store_pdf_manual_confirm_v1', {
      p_order_id: order.id,
      p_buyer_id: order.buyer_id,
      p_bank_reference: reference,
      p_verified_amount_usd: amount,
      p_bank_paid_at: bankPaidAt.toISOString(),
      p_admin_id: admin.id,
      p_admin_email: admin.email,
      p_reason: reason,
    })
    if (error) {
      if (String(error.code || '') === 'PGRST202') return res.status(503).json({ ok: false, message: 'PDF Recovery SQL is not installed yet' })
      return res.status(409).json({ ok: false, message: String(error.message || 'Manual PDF verification was rejected').slice(0, 250) })
    }
    let result
    try {
      result = await attemptAuthorStorePdfRecovery(order, { source: 'admin', admin, reason })
    } catch (recoveryError) {
      console.error('ADMIN MANUAL PDF PAYMENT CONFIRMED BUT RECOVERY FAILED:', order.order_id, String(recoveryError?.message || recoveryError).slice(0, 200))
      result = { state: 'access_recovery', order_id: order.order_id, error: 'PDF delivery will be retried by the recovery worker' }
    }
    res.set('Cache-Control', 'no-store')
    return res.status(result.state === 'purchased' ? 200 : 202).json({
      ok: true,
      payment_confirmed: true,
      already_confirmed: Boolean(data?.already_confirmed),
      recovery: result,
      no_new_payment: true,
    })
  } catch (error) {
    return errorResponse(res, error)
  }
}
