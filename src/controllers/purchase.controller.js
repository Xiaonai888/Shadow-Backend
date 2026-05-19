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

function getUserId(req) {
  return req.user?.user_id || req.user?.id || null
}

function getPackageByUsd(value) {
  const packageUsd = Number(value)
  return PACKAGES.find((item) => item.package_usd === packageUsd) || null
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

function publicTransaction(item) {
  return {
    id: item.id,
    user_id: item.user_id,
    order_id: item.order_id,
    aba_transaction_id: item.aba_transaction_id || '',
    package_usd: Number(item.package_usd || 0),
    amount_usd: Number(item.amount_usd || 0),
    diamonds: Number(item.diamonds || 0),
    bonus_gems: Number(item.bonus_gems || 0),
    payment_method: item.payment_method || 'aba_khqr',
    qr_string: item.qr_string || '',
    checkout_url: item.checkout_url || '',
    status: item.status,
    created_at: item.created_at,
    expired_at: item.expired_at,
    paid_at: item.paid_at,
    updated_at: item.updated_at,
  }
}

function publicPurchase(item, userMap = {}) {
  const user = userMap[item.user_id] || null

  return {
    id: item.id,
    user_id: item.user_id,
    package_usd: Number(item.package_usd || 0),
    diamonds: Number(item.diamonds || 0),
    bonus_gems: Number(item.bonus_gems || 0),
    payment_method: item.payment_method || 'aba_khqr',
    payer_name: item.payer_name || '',
    payment_reference: item.payment_reference || '',
    proof_url: item.proof_url || '',
    status: item.status,
    admin_note: item.admin_note || '',
    approved_by: item.approved_by || '',
    approved_at: item.approved_at,
    rejected_at: item.rejected_at,
    created_at: item.created_at,
    updated_at: item.updated_at,
    user,
  }
}

function createOrderId() {
  return `SHD-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`
}

function formatAmount(value) {
  return Number(value || 0).toFixed(2)
}

function getHashFields() {
  return String(process.env.ABA_PAYWAY_HASH_FIELDS || 'req_time,merchant_id,tran_id,amount,currency,payment_option,return_url,continue_success_url,return_params')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function createHashFromFields(payload) {
  const secret = process.env.ABA_PAYWAY_HASH_KEY || process.env.ABA_PAYWAY_SECRET_KEY || ''
  if (!secret) return ''

  const raw = getHashFields().map((field) => payload[field] || '').join('')
  return crypto.createHmac('sha512', secret).update(raw).digest('base64')
}

function getCallbackSignature(req) {
  return String(req.headers['x-aba-signature'] || req.headers['x-payway-signature'] || req.body.hash || req.body.signature || '').trim()
}

function verifyCallback(req) {
  const secret = process.env.ABA_PAYWAY_CALLBACK_SECRET || process.env.ABA_PAYWAY_HASH_KEY || process.env.ABA_PAYWAY_SECRET_KEY || ''
  const devMode = process.env.ABA_PAYMENT_DEV_MODE === 'true'

  if (devMode) return true
  if (!secret) return false

  const signature = getCallbackSignature(req)
  if (!signature) return false

  const payload = { ...req.body }
  delete payload.hash
  delete payload.signature

  const raw = JSON.stringify(payload)
  const expectedBase64 = crypto.createHmac('sha512', secret).update(raw).digest('base64')
  const expectedHex = crypto.createHmac('sha512', secret).update(raw).digest('hex')

  return signature === expectedBase64 || signature === expectedHex
}

function getCallbackOrderId(body) {
  return String(body.order_id || body.tran_id || body.transaction_id || body.return_params || '').trim()
}

function getCallbackStatus(body) {
  return String(body.status || body.payment_status || body.result || body.approval_status || '').trim().toLowerCase()
}

function isSuccessStatus(value) {
  return ['success', 'successful', 'approved', 'paid', 'completed', '0'].includes(value)
}

function extractAbaResponse(data) {
  const source = data?.data || data || {}

  return {
    raw: data || {},
    qr_string: source.qr_string || source.qrString || source.abapay_khqr || source.khqr || source.qr || '',
    checkout_url: source.checkout_url || source.checkoutUrl || source.payment_url || source.paymentUrl || source.url || '',
    aba_transaction_id: source.transaction_id || source.tran_id || source.payment_id || '',
  }
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
    .insert({
      user_id: userId,
      diamond_balance: 0,
      gem_balance: 0,
    })
    .select('*')
    .single()

  if (error) throw error
  return data
}

async function getUsersMap(userIds) {
  const ids = [...new Set(userIds.filter(Boolean))]

  if (!ids.length) return {}

  const { data, error } = await supabase
    .from('users')
    .select('id, name, username, email, avatar_url')
    .in('id', ids)

  if (error) throw error

  return Object.fromEntries(
    (data || []).map((user) => [
      user.id,
      {
        id: user.id,
        name: user.name || '',
        username: user.username || '',
        email: user.email || '',
        avatar_url: user.avatar_url || '',
      },
    ])
  )
}

async function createAbaPaywayCharge({ orderId, amountUsd }) {
  const url = process.env.ABA_PAYWAY_CREATE_PAYMENT_URL || ''
  const merchantId = process.env.ABA_PAYWAY_MERCHANT_ID || ''
  const returnUrl = process.env.ABA_PAYWAY_RETURN_URL || ''
  const successUrl = process.env.ABA_PAYWAY_SUCCESS_URL || ''
  const currency = process.env.ABA_PAYWAY_CURRENCY || 'USD'
  const paymentOption = process.env.ABA_PAYWAY_PAYMENT_OPTION || 'abapay_khqr'
  const reqTime = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)

  const payload = {
    req_time: reqTime,
    merchant_id: merchantId,
    tran_id: orderId,
    amount: formatAmount(amountUsd),
    currency,
    payment_option: paymentOption,
    return_url: returnUrl,
    continue_success_url: successUrl,
    return_params: orderId,
    lifetime: '2',
  }

  const hash = createHashFromFields(payload)
  const body = hash ? { ...payload, hash } : payload

  if (!url || !merchantId) {
    return {
      configured: false,
      qr_string: '',
      checkout_url: '',
      aba_transaction_id: '',
      raw: { message: 'ABA PayWay is not configured' },
    }
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  const text = await response.text()
  let data = {}

  try {
    data = text ? JSON.parse(text) : {}
  } catch (error) {
    data = { raw: text }
  }

  if (!response.ok) {
    throw new Error(data.message || data.error || 'ABA PayWay payment creation failed')
  }

  return {
    configured: true,
    ...extractAbaResponse(data),
  }
}

export async function getPurchasePackages(req, res) {
  return res.status(200).json({
    ok: true,
    packages: PACKAGES,
  })
}

export async function getMyWallet(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'User is required',
      })
    }

    const wallet = await getOrCreateWallet(userId)

    return res.status(200).json({
      ok: true,
      wallet: publicWallet(wallet),
    })
  } catch (error) {
    console.error('GET MY WALLET ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load wallet',
      error: error.message,
    })
  }
}

export async function createAbaPayment(req, res) {
  try {
    const userId = getUserId(req)
    const selectedPackage = getPackageByUsd(req.body.package_usd)

    if (!userId) {
      return res.status(401).json({
        ok: false,
        message: 'User is required',
      })
    }

    if (!selectedPackage) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid purchase package',
      })
    }

    const orderId = createOrderId()
    const createdAt = new Date()
    const expiredAt = new Date(createdAt.getTime() + 2 * 60 * 1000).toISOString()
    const aba = await createAbaPaywayCharge({ orderId, amountUsd: selectedPackage.package_usd })

    const { data, error } = await supabase
      .from('payment_transactions')
      .insert({
        user_id: userId,
        order_id: orderId,
        aba_transaction_id: aba.aba_transaction_id || null,
        package_usd: selectedPackage.package_usd,
        amount_usd: selectedPackage.package_usd,
        diamonds: selectedPackage.diamonds,
        bonus_gems: selectedPackage.bonus_gems,
        payment_method: 'aba_khqr',
        qr_string: aba.qr_string || null,
        checkout_url: aba.checkout_url || null,
        status: 'waiting_payment',
        aba_payload: aba.raw || {},
        expired_at: expiredAt,
      })
      .select('*')
      .single()

    if (error) throw error

    return res.status(201).json({
      ok: true,
      configured: aba.configured,
      payment: publicTransaction(data),
    })
  } catch (error) {
    console.error('CREATE ABA PAYMENT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to create ABA payment',
      error: error.message,
    })
  }
}

export async function getAbaPaymentStatus(req, res) {
  try {
    const userId = getUserId(req)
    const orderId = String(req.params.orderId || '').trim()

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'User is required' })
    }

    const { data: expiredData, error: expiredError } = await supabase.rpc('expire_aba_payment', {
      p_order_id: orderId,
    })

    if (expiredError) throw expiredError

    const payment = Array.isArray(expiredData) ? expiredData[0] : expiredData

    if (!payment || payment.user_id !== userId) {
      return res.status(404).json({ ok: false, message: 'Payment not found' })
    }

    return res.status(200).json({
      ok: true,
      payment: publicTransaction(payment),
    })
  } catch (error) {
    console.error('GET ABA PAYMENT STATUS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load payment status',
      error: error.message,
    })
  }
}

export async function handleAbaCallback(req, res) {
  try {
    if (!verifyCallback(req)) {
      return res.status(401).json({ ok: false, message: 'Invalid callback signature' })
    }

    const orderId = getCallbackOrderId(req.body)
    const status = getCallbackStatus(req.body)
    const abaTransactionId = String(req.body.aba_transaction_id || req.body.transaction_id || req.body.tran_id || req.body.payment_id || '').trim()

    if (!orderId) {
      return res.status(400).json({ ok: false, message: 'Missing order id' })
    }

    if (!isSuccessStatus(status)) {
      await supabase
        .from('payment_transactions')
        .update({
          status: status === 'cancelled' || status === 'canceled' ? 'cancelled' : 'failed',
          aba_payload: req.body,
          updated_at: new Date().toISOString(),
        })
        .eq('order_id', orderId)
        .eq('status', 'waiting_payment')

      return res.status(200).json({ ok: true })
    }

    const { data, error } = await supabase.rpc('release_aba_payment', {
      p_order_id: orderId,
      p_aba_transaction_id: abaTransactionId || null,
      p_aba_payload: req.body,
    })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      wallet: Array.isArray(data) ? data[0] : data,
    })
  } catch (error) {
    console.error('ABA CALLBACK ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to process ABA callback',
    })
  }
}

export async function createPurchaseRequest(req, res) {
  try {
    const userId = getUserId(req)
    const selectedPackage = getPackageByUsd(req.body.package_usd)

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'User is required' })
    }

    if (!selectedPackage) {
      return res.status(400).json({ ok: false, message: 'Invalid purchase package' })
    }

    const { data, error } = await supabase
      .from('purchase_requests')
      .insert({
        user_id: userId,
        package_usd: selectedPackage.package_usd,
        diamonds: selectedPackage.diamonds,
        bonus_gems: selectedPackage.bonus_gems,
        payment_method: 'aba_khqr',
        status: 'pending',
      })
      .select('*')
      .single()

    if (error) throw error

    return res.status(201).json({ ok: true, purchase: publicPurchase(data) })
  } catch (error) {
    console.error('CREATE PURCHASE REQUEST ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to create purchase request',
      error: error.message,
    })
  }
}

export async function getMyPurchaseRequests(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'User is required' })
    }

    const { data, error } = await supabase
      .from('payment_transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      purchases: (data || []).map((item) => publicTransaction(item)),
    })
  } catch (error) {
    console.error('GET MY PURCHASE REQUESTS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load purchase requests',
      error: error.message,
    })
  }
}

export async function getAdminPurchaseRequests(req, res) {
  try {
    const status = String(req.query.status || '').trim()
    let query = supabase
      .from('purchase_requests')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100)

    if (['pending', 'approved', 'rejected'].includes(status)) query = query.eq('status', status)

    const { data, error } = await query

    if (error) throw error

    const userMap = await getUsersMap((data || []).map((item) => item.user_id))

    return res.status(200).json({
      ok: true,
      purchases: (data || []).map((item) => publicPurchase(item, userMap)),
    })
  } catch (error) {
    console.error('GET ADMIN PURCHASE REQUESTS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load purchase requests',
      error: error.message,
    })
  }
}

export async function getAdminPurchaseRequest(req, res) {
  try {
    const requestId = String(req.params.requestId || '').trim()

    const { data, error } = await supabase
      .from('purchase_requests')
      .select('*')
      .eq('id', requestId)
      .maybeSingle()

    if (error) throw error

    if (!data) return res.status(404).json({ ok: false, message: 'Purchase request not found' })

    const userMap = await getUsersMap([data.user_id])

    return res.status(200).json({ ok: true, purchase: publicPurchase(data, userMap) })
  } catch (error) {
    console.error('GET ADMIN PURCHASE REQUEST ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load purchase request',
      error: error.message,
    })
  }
}

export async function approveAdminPurchaseRequest(req, res) {
  try {
    const requestId = String(req.params.requestId || '').trim()
    const adminName = req.admin?.username || req.admin?.email || req.admin?.name || 'admin'
    const noteText = String(req.body.admin_note || '').trim() || null

    const { data, error } = await supabase.rpc('approve_purchase_request', {
      request_id: requestId,
      admin_name: adminName,
      note_text: noteText,
    })

    if (error) throw error

    const { data: purchase, error: purchaseError } = await supabase
      .from('purchase_requests')
      .select('*')
      .eq('id', requestId)
      .single()

    if (purchaseError) throw purchaseError

    const userMap = await getUsersMap([purchase.user_id])

    return res.status(200).json({
      ok: true,
      wallet: Array.isArray(data) ? data[0] : data,
      purchase: publicPurchase(purchase, userMap),
    })
  } catch (error) {
    console.error('APPROVE ADMIN PURCHASE REQUEST ERROR:', error)

    return res.status(500).json({ ok: false, message: error.message || 'Failed to approve purchase request' })
  }
}

export async function rejectAdminPurchaseRequest(req, res) {
  try {
    const requestId = String(req.params.requestId || '').trim()
    const adminName = req.admin?.username || req.admin?.email || req.admin?.name || 'admin'
    const noteText = String(req.body.admin_note || '').trim() || null

    const { error } = await supabase.rpc('reject_purchase_request', {
      request_id: requestId,
      admin_name: adminName,
      note_text: noteText,
    })

    if (error) throw error

    const { data: purchase, error: purchaseError } = await supabase
      .from('purchase_requests')
      .select('*')
      .eq('id', requestId)
      .single()

    if (purchaseError) throw purchaseError

    const userMap = await getUsersMap([purchase.user_id])

    return res.status(200).json({ ok: true, purchase: publicPurchase(purchase, userMap) })
  } catch (error) {
    console.error('REJECT ADMIN PURCHASE REQUEST ERROR:', error)

    return res.status(500).json({ ok: false, message: error.message || 'Failed to reject purchase request' })
  }
}
