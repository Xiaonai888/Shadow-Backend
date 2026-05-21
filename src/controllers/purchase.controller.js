import crypto from 'crypto'
import { supabase } from '../config/supabase.js'

const PACKAGES = [
  { package_usd: 1, diamonds: 100, bonus_gems: 0 },
  { package_usd: 5, diamonds: 500, bonus_gems: 1000 },
  { package_usd: 10, diamonds: 1000, bonus_gems: 2000 },
  { package_usd: 20, diamonds: 2000, bonus_gems: 4000 },
  { package_usd: 50, diamonds: 5000, bonus_gems: 10000 },
  { package_usd: 100, diamonds: 10000, bonus_gems: 20000 },
]

const PAYWAY_HASH_ORDER = [
  'req_time',
  'merchant_id',
  'tran_id',
  'amount',
  'items',
  'first_name',
  'last_name',
  'email',
  'phone',
  'purchase_type',
  'payment_option',
  'callback_url',
  'return_deeplink',
  'currency',
  'custom_fields',
  'return_params',
  'payout',
  'lifetime',
  'qr_image_template',
]

function getUserId(req) {
  return req.user?.user_id || req.user?.id || null
}

function getPackageByUsd(value) {
  const packageUsd = Number(value)
  return PACKAGES.find((item) => item.package_usd === packageUsd) || null
}

function formatUsd(value) {
  return Number(value || 0).toFixed(2)
}

function getUtcReqTime() {
  const date = new Date()
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  const hour = String(date.getUTCHours()).padStart(2, '0')
  const minute = String(date.getUTCMinutes()).padStart(2, '0')
  const second = String(date.getUTCSeconds()).padStart(2, '0')

  return `${year}${month}${day}${hour}${minute}${second}`
}

function base64(value) {
  return Buffer.from(String(value || ''), 'utf8').toString('base64')
}

function createTranId() {
  const time = Date.now().toString(36).toUpperCase()
  const random = crypto.randomBytes(4).toString('hex').toUpperCase()
  return `S${time}${random}`.slice(0, 20)
}

function getPayWayQrUrl() {
  const directUrl = process.env.ABA_PAYWAY_QR_URL || ''
  if (directUrl) return directUrl

  const mode = String(process.env.ABA_PAYWAY_MODE || 'sandbox').toLowerCase()

  if (mode === 'production' || mode === 'live') {
    return process.env.ABA_PAYWAY_PRODUCTION_QR_URL || 'https://checkout.payway.com.kh/api/payment-gateway/v1/payments/generate-qr'
  }

  return process.env.ABA_PAYWAY_SANDBOX_QR_URL || 'https://checkout-sandbox.payway.com.kh/api/payment-gateway/v1/payments/generate-qr'
}

function createPayWayHash(payload) {
  const apiKey = process.env.ABA_PAYWAY_API_KEY || ''
  if (!apiKey) return ''

  const raw = PAYWAY_HASH_ORDER.map((field) => payload[field] ?? '').join('')
  return crypto.createHmac('sha512', apiKey).update(raw).digest('base64')
}

function buildPayWayPayload({ tranId, amount, user }) {
  const callbackUrl = process.env.ABA_PAYWAY_CALLBACK_URL || 'https://shadow-backend-kucw.onrender.com/api/purchase/aba/callback'
  const returnParams = JSON.stringify({ order_id: tranId })
  const lifetime = Number(process.env.ABA_PAYWAY_LIFETIME || 3)

  const payload = {
    req_time: getUtcReqTime(),
    merchant_id: process.env.ABA_PAYWAY_MERCHANT_ID || '',
    tran_id: tranId,
    amount,
    items: base64(JSON.stringify([{ name: `Shadow Diamonds ${amount} USD`, quantity: 1, price: Number(amount) }])),
    first_name: String(user?.name || 'Shadow').slice(0, 50),
    last_name: 'Reader',
    email: String(user?.email || 'support@shadowerabook.site'),
    phone: String(process.env.ABA_PAYWAY_DEFAULT_PHONE || '012345678'),
    purchase_type: 'purchase',
    payment_option: process.env.ABA_PAYWAY_PAYMENT_OPTION || 'abapay_khqr',
    callback_url: base64(callbackUrl),
    currency: process.env.ABA_PAYWAY_CURRENCY || 'USD',
    return_params: returnParams,
    lifetime: Math.max(3, lifetime),
    qr_image_template: process.env.ABA_PAYWAY_QR_TEMPLATE || 'template3_color',
  }

  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined && value !== null && value !== ''))
}

function publicWallet(wallet) {
  return {
    id: wallet.id,
    user_id: wallet.user_id,
    diamond_balance: Number(wallet.diamond_balance || 0),
    gem_balance: Number(wallet.gem_balance || 0),
    created_at: wallet.created_at,
    updated_at: wallet.updated_at,
  }
}

function publicPayment(item) {
  return {
    id: item.id,
    user_id: item.user_id,
    order_id: item.order_id,
    aba_transaction_id: item.aba_transaction_id || '',
    aba_trx_id: item.aba_trx_id || item.aba_transaction_id || '',
    aba_apv: item.aba_apv || '',
    package_usd: Number(item.package_usd || 0),
    amount_usd: Number(item.amount_usd || 0),
    currency: item.currency || 'USD',
    diamonds: Number(item.diamonds || 0),
    bonus_gems: Number(item.bonus_gems || 0),
    payment_method: item.payment_method || 'aba_khqr',
    qr_string: item.qr_string || '',
    qr_image: item.qr_image || '',
    checkout_url: item.checkout_url || '',
    deeplink: item.deeplink || '',
    status: item.status,
    match_status: item.match_status || '',
    match_reason: item.match_reason || '',
    admin_note: item.admin_note || '',
    created_at: item.created_at,
    expires_at: item.expires_at,
    paid_at: item.paid_at,
    released_at: item.released_at,
    updated_at: item.updated_at,
  }
}

function extractQrResponse(data) {
  const source = data?.data || data || {}

  return {
    qr_string: source.qrString || source.qr_string || source.khqr || source.qr || '',
    qr_image: source.qrImage || source.qr_image || '',
    deeplink: source.abapay_deeplink || source.deeplink || '',
    checkout_url: source.checkout_url || source.payment_url || source.url || '',
    aba_transaction_id: source.transaction_id || source.tran_id || '',
    raw: data || {},
  }
}

function parseReturnParams(value) {
  if (!value) return {}

  try {
    return JSON.parse(String(value))
  } catch {}

  try {
    return JSON.parse(Buffer.from(String(value), 'base64').toString('utf8'))
  } catch {}

  return {}
}

function getCallbackOrderId(body) {
  const returnParams = parseReturnParams(body.return_params)
  return String(body.merchant_ref || body.tran_id || body.transaction_id || returnParams.order_id || '').trim()
}

function isApprovedCallback(body) {
  const status = String(body.status ?? body?.status?.code ?? '').trim().toLowerCase()
  const paymentStatus = String(body.payment_status || '').trim().toLowerCase()
  const paymentStatusCode = String(body.payment_status_code ?? '').trim().toLowerCase()

  return status === '0' || status === '00' || paymentStatusCode === '0' || paymentStatusCode === '00' || paymentStatus === 'approved'
}

function callbackAmountMatches(payment, body) {
  const callbackAmount = body.payment_amount ?? body.original_amount ?? body.amount
  const callbackCurrency = body.payment_currency || body.original_currency || body.currency

  if (callbackAmount === undefined || callbackAmount === null || callbackAmount === '') return true
  if (callbackCurrency && String(callbackCurrency).toUpperCase() !== String(payment.currency || 'USD').toUpperCase()) return false

  return Number(callbackAmount).toFixed(2) === Number(payment.amount_usd).toFixed(2)
}

async function getOrCreateWallet(userId) {
  const { data: existingWallet, error: existingError } = await supabase
    .from('user_wallets')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()

  if (existingError) throw existingError
  if (existingWallet) return existingWallet

  const { data, error } = await supabase
    .from('user_wallets')
    .insert({ user_id: userId, diamond_balance: 0, gem_balance: 0 })
    .select('*')
    .single()

  if (error) throw error
  return data
}

async function getUserProfile(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('id, name, email, username')
    .eq('id', userId)
    .maybeSingle()

  if (error) throw error
  return data || null
}

async function callPayWayGenerateQr(payload) {
  const qrUrl = getPayWayQrUrl()
  const hash = createPayWayHash(payload)

  if (!payload.merchant_id || !process.env.ABA_PAYWAY_API_KEY) {
    return {
      configured: false,
      qr_string: '',
      qr_image: '',
      deeplink: '',
      checkout_url: '',
      aba_transaction_id: '',
      raw: { message: 'ABA PayWay QR API is not configured' },
    }
  }

  const response = await fetch(qrUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, hash }),
  })

  const text = await response.text()
  let data = {}

  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text }
  }

  if (!response.ok) {
    throw new Error(data.message || data.error || 'ABA PayWay QR generation failed')
  }

  return {
    configured: true,
    ...extractQrResponse(data),
  }
}

export async function getPurchasePackages(req, res) {
  return res.status(200).json({ ok: true, packages: PACKAGES })
}

export async function getMyWallet(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) return res.status(401).json({ ok: false, message: 'User is required' })

    const wallet = await getOrCreateWallet(userId)

    return res.status(200).json({ ok: true, wallet: publicWallet(wallet) })
  } catch (error) {
    console.error('GET MY WALLET ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load wallet', error: error.message })
  }
}

export async function createAbaPayment(req, res) {
  try {
    const userId = getUserId(req)
    const selectedPackage = getPackageByUsd(req.body.package_usd)

    if (!userId) return res.status(401).json({ ok: false, message: 'User is required' })
    if (!selectedPackage) return res.status(400).json({ ok: false, message: 'Invalid purchase package' })

    const user = await getUserProfile(userId)
    const tranId = createTranId()
    const amount = formatUsd(selectedPackage.package_usd)
    const payload = buildPayWayPayload({ tranId, amount, user })
    const aba = await callPayWayGenerateQr(payload)
    const expiresAt = new Date(Date.now() + Number(payload.lifetime) * 60 * 1000).toISOString()

    const { data, error } = await supabase
      .from('payment_transactions')
      .insert({
        user_id: userId,
        order_id: tranId,
        aba_transaction_id: aba.aba_transaction_id || null,
        package_usd: selectedPackage.package_usd,
        amount_usd: selectedPackage.package_usd,
        currency: payload.currency,
        diamonds: selectedPackage.diamonds,
        bonus_gems: selectedPackage.bonus_gems,
        payment_method: 'aba_khqr',
        qr_string: aba.qr_string || null,
        qr_image: aba.qr_image || null,
        checkout_url: aba.checkout_url || null,
        deeplink: aba.deeplink || null,
        status: 'waiting_payment',
        request_payload: payload,
        aba_payload: aba.raw || {},
        expires_at: expiresAt,
      })
      .select('*')
      .single()

    if (error) throw error

    return res.status(201).json({ ok: true, configured: aba.configured, payment: publicPayment(data) })
  } catch (error) {
    console.error('CREATE ABA PAYMENT ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to create ABA payment', error: error.message })
  }
}

export async function getAbaPaymentStatus(req, res) {
  try {
    const userId = getUserId(req)
    const orderId = String(req.params.orderId || '').trim()

    if (!userId) return res.status(401).json({ ok: false, message: 'User is required' })

    await supabase.rpc('expire_waiting_payment', { p_order_id: orderId })

    const { data, error } = await supabase
      .from('payment_transactions')
      .select('*')
      .eq('order_id', orderId)
      .eq('user_id', userId)
      .maybeSingle()

    if (error) throw error
    if (!data) return res.status(404).json({ ok: false, message: 'Payment not found' })

    return res.status(200).json({ ok: true, payment: publicPayment(data) })
  } catch (error) {
    console.error('GET ABA PAYMENT STATUS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load payment status', error: error.message })
  }
}

export async function handleAbaCallback(req, res) {
  try {
    const orderId = getCallbackOrderId(req.body)

    if (!orderId) return res.status(400).json({ ok: false, message: 'Missing order id' })

    const { data: payment, error: paymentError } = await supabase
      .from('payment_transactions')
      .select('*')
      .eq('order_id', orderId)
      .maybeSingle()

    if (paymentError) throw paymentError
    if (!payment) return res.status(404).json({ ok: false, message: 'Payment not found' })

    await supabase.from('payment_callbacks').insert({
      payment_transaction_id: payment.id,
      order_id: orderId,
      payload: req.body,
      status_detected: isApprovedCallback(req.body) ? 'approved' : 'not_approved',
    })

    if (!isApprovedCallback(req.body)) {
      await supabase
        .from('payment_transactions')
        .update({ callback_payload: req.body, updated_at: new Date().toISOString() })
        .eq('id', payment.id)

      return res.status(200).json({ ok: true })
    }

    if (!callbackAmountMatches(payment, req.body)) {
      await supabase
        .from('payment_transactions')
        .update({ status: 'amount_mismatch', callback_payload: req.body, updated_at: new Date().toISOString() })
        .eq('id', payment.id)

      return res.status(200).json({ ok: true })
    }

    if (payment.status !== 'waiting_payment') return res.status(200).json({ ok: true })

    await supabase
      .from('payment_transactions')
      .update({
        status: 'callback_received',
        aba_transaction_id: req.body.transaction_id || req.body.tran_id || payment.aba_transaction_id || null,
        callback_payload: req.body,
        paid_at: req.body.transaction_date ? new Date(req.body.transaction_date).toISOString() : new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', payment.id)
      .eq('status', 'waiting_payment')

    return res.status(200).json({ ok: true })
  } catch (error) {
    console.error('ABA CALLBACK ERROR:', error)
    return res.status(500).json({ ok: false, message: error.message || 'Failed to process ABA callback' })
  }
}

export async function getMyPurchaseRequests(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) return res.status(401).json({ ok: false, message: 'User is required' })

    const page = Math.max(Number(req.query.page || 1), 1)
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 20)
    const from = (page - 1) * limit
    const to = from + limit - 1
    const status = String(req.query.status || 'all').trim().toLowerCase()
    const search = String(req.query.q || req.query.search || '').trim()

    const cutoffDate = new Date()
    cutoffDate.setFullYear(cutoffDate.getFullYear() - 1)
    const cutoffIso = cutoffDate.toISOString()

    let query = supabase
      .from('payment_transactions')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .gte('created_at', cutoffIso)

    if (status && status !== 'all') {
      query = query.eq('status', status)
    }

    if (search) {
      const safeSearch = search.replace(/[%_,]/g, '')
      query = query.or(`order_id.ilike.%${safeSearch}%,aba_transaction_id.ilike.%${safeSearch}%`)
    }

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) throw error

    const total = Number(count || 0)
    const totalPages = Math.max(Math.ceil(total / limit), 1)

    return res.status(200).json({
      ok: true,
      purchases: (data || []).map((item) => publicPayment(item)),
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
      history_limit_days: 365,
    })
  } catch (error) {
    console.error('GET MY PURCHASE REQUESTS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load purchase requests', error: error.message })
  }
}
