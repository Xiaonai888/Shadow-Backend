import crypto from 'crypto'
import { supabase } from '../config/supabase.js'

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

const DELIVERY_FEE_USD = 2
const ADMIN_ORDER_STATUSES = ['under_review', 'confirmed', 'preparing', 'shipped', 'completed', 'cancelled', 'rejected']

function getUserId(req) {
  return req.user?.user_id || req.user?.id || null
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

function createOrderId() {
  const time = Date.now().toString(36).toUpperCase()
  const random = crypto.randomBytes(4).toString('hex').toUpperCase()
  return `M${time}${random}`.slice(0, 20)
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

function callbackAmountMatches(order, body) {
  const callbackAmount = body.payment_amount ?? body.original_amount ?? body.amount
  const callbackCurrency = body.payment_currency || body.original_currency || body.currency

  if (callbackAmount === undefined || callbackAmount === null || callbackAmount === '') return true
  if (callbackCurrency && String(callbackCurrency).toUpperCase() !== String(order.currency || 'USD').toUpperCase()) return false

  return Number(callbackAmount).toFixed(2) === Number(order.total_usd).toFixed(2)
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

function publicMallOrder(order) {
  return {
    id: order.id,
    user_id: order.user_id,
    order_id: order.order_id,
    aba_transaction_id: order.aba_transaction_id || '',
    items: order.items || [],
    buyer_profile: order.buyer_profile || {},
    delivery_company: order.delivery_company || {},
    subtotal_usd: Number(order.subtotal_usd || 0),
    delivery_fee_usd: Number(order.delivery_fee_usd || 0),
    total_usd: Number(order.total_usd || 0),
    currency: order.currency || 'USD',
    qr_string: order.qr_string || '',
    qr_image: order.qr_image || '',
    checkout_url: order.checkout_url || '',
    deeplink: order.deeplink || '',
    status: order.status,
    created_at: order.created_at,
    expires_at: order.expires_at,
    paid_at: order.paid_at,
    updated_at: order.updated_at,
  }
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

async function getBuyerProfile(userId) {
  const { data, error } = await supabase
    .from('shadow_mall_buyer_profiles')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  return data || null
}

function buildPayWayPayload({ orderId, amount, user, phone, payItems }) {
  const callbackUrl =
    process.env.ABA_PAYWAY_MALL_CALLBACK_URL ||
    'https://shadow-backend-kucw.onrender.com/api/shadow-mall/orders/callback'

  const returnParams = JSON.stringify({ order_id: orderId, type: 'shadow_mall_order' })
  const lifetime = Number(process.env.ABA_PAYWAY_LIFETIME || 3)

  const payload = {
    req_time: getUtcReqTime(),
    merchant_id: process.env.ABA_PAYWAY_MERCHANT_ID || '',
    tran_id: orderId,
    amount,
    items: base64(JSON.stringify(payItems)),
    first_name: String(user?.name || 'Shadow').slice(0, 50),
    last_name: 'Mall',
    email: String(user?.email || 'support@shadowerabook.site'),
    phone: String(phone || process.env.ABA_PAYWAY_DEFAULT_PHONE || '012345678'),
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

async function buildOrderItems(cartItems) {
  function createCartSignature(orderItems, deliveryCompany) {
  const items = [...orderItems]
    .map((item) => ({
      product_id: String(item.product_id),
      quantity: Number(item.quantity || 1),
    }))
    .sort((a, b) => String(a.product_id).localeCompare(String(b.product_id)))

  const payload = {
    items,
    delivery_company_key: deliveryCompany?.key || deliveryCompany?.shortName || deliveryCompany?.name || '',
  }

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')
}
  const cleanItems = Array.isArray(cartItems)
    ? cartItems
        .map((item) => ({
          product_id: String(item.id || item.product_id || '').trim(),
          quantity: Math.max(1, Math.min(Number(item.quantity || 1), 99)),
        }))
        .filter((item) => item.product_id)
    : []

  if (!cleanItems.length) {
    throw new Error('Cart is empty')
  }

  const ids = cleanItems.map((item) => item.product_id)

  const { data: products, error } = await supabase
    .from('shadow_mall_products')
    .select('id, title, author_name, cover_url, price_usd, stock_status, stock_quantity, is_active')
    .in('id', ids)

  if (error) throw error

  const productMap = new Map((products || []).map((product) => [String(product.id), product]))

  return cleanItems.map((item) => {
    const product = productMap.get(String(item.product_id))

    if (!product || !product.is_active) {
      throw new Error('Some books are no longer available')
    }

    if (product.stock_status === 'sold_out') {
      throw new Error(`${product.title} is sold out`)
    }

    const quantityAvailable = Number(product.stock_quantity || 0)
    if (product.stock_status !== 'pre_order' && quantityAvailable > 0 && item.quantity > quantityAvailable) {
      throw new Error(`${product.title} has only ${quantityAvailable} in stock`)
    }

    const unitPrice = Number(product.price_usd || 0)

    return {
      product_id: product.id,
      title: product.title,
      author_name: product.author_name || '',
      cover_url: product.cover_url || '',
      quantity: item.quantity,
      unit_price_usd: unitPrice,
      total_usd: Number((unitPrice * item.quantity).toFixed(2)),
    }
  })
}

export async function deductShadowMallOrderStock(order) {
  const items = Array.isArray(order?.items) ? order.items : []

  for (const item of items) {
    const productId = item.product_id
    const quantity = Math.max(1, Number(item.quantity || 1))

    if (!productId || !quantity) continue

    const { data: product, error: productError } = await supabase
      .from('shadow_mall_products')
      .select('id, stock_quantity, stock_status')
      .eq('id', productId)
      .maybeSingle()

    if (productError) throw productError
    if (!product) continue

    if (product.stock_status === 'pre_order') continue

    const currentQuantity = Math.max(0, Number(product.stock_quantity || 0))
    const nextQuantity = Math.max(0, currentQuantity - quantity)

    const payload = {
      stock_quantity: nextQuantity,
      updated_at: new Date().toISOString(),
    }

    if (nextQuantity <= 0) {
      payload.stock_status = 'sold_out'
      payload.sold_out_at = new Date().toISOString()
    }

    const { error: updateError } = await supabase
      .from('shadow_mall_products')
      .update(payload)
      .eq('id', productId)

    if (updateError) throw updateError
  }
}

export async function createShadowMallOrderPayment(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) return res.status(401).json({ ok: false, message: 'User is required' })

    const user = await getUserProfile(userId)
    const buyerProfile = await getBuyerProfile(userId)

    if (!buyerProfile?.phone_number || !buyerProfile?.delivery_address) {
      return res.status(400).json({ ok: false, message: 'Buyer profile is required before payment' })
    }

    const orderItems = await buildOrderItems(req.body.items)
const subtotal = Number(orderItems.reduce((total, item) => total + item.total_usd, 0).toFixed(2))
const deliveryFee = DELIVERY_FEE_USD
const total = Number((subtotal + deliveryFee).toFixed(2))

const deliveryCompany = req.body.delivery_company || {
  key: 'jnt',
  name: 'J&T Express',
  shortName: 'J&T',
}

const cartSignature = createCartSignature(orderItems, deliveryCompany)
const activeWindowStart = new Date(Date.now() - 20 * 60 * 1000).toISOString()

const { data: currentOrder, error: currentOrderError } = await supabase
  .from('shadow_mall_orders')
  .select('*')
  .eq('user_id', userId)
  .eq('status', 'waiting_payment')
  .eq('cart_signature', cartSignature)
  .gte('created_at', activeWindowStart)
  .order('created_at', { ascending: false })
  .limit(1)
  .maybeSingle()

if (currentOrderError) throw currentOrderError

if (currentOrder) {
  return res.status(200).json({
    ok: true,
    reused: true,
    order: publicMallOrder(currentOrder),
  })
}

const orderId = createOrderId()

    const payItems = [
      ...orderItems.map((item) => ({
        name: item.title,
        quantity: item.quantity,
        price: item.unit_price_usd,
      })),
      {
        name: `${deliveryCompany.shortName || deliveryCompany.name || 'Delivery'} delivery fee`,
        quantity: 1,
        price: deliveryFee,
      },
    ]

    const amount = formatUsd(total)
    const payload = buildPayWayPayload({
      orderId,
      amount,
      user,
      phone: buyerProfile.phone_number,
      payItems,
    })

    const aba = await callPayWayGenerateQr(payload)
    const expiresAt = new Date(Date.now() + Number(payload.lifetime) * 60 * 1000).toISOString()

    const { data, error } = await supabase
      .from('shadow_mall_orders')
.insert({
  user_id: userId,
  order_id: orderId,
  cart_signature: cartSignature,
  aba_transaction_id: aba.aba_transaction_id || null,
  items: orderItems,
        buyer_profile: {
          name: user?.name || user?.username || '',
          phone_number: buyerProfile.phone_number,
          telegram_username: buyerProfile.telegram_username || '',
          facebook_link: buyerProfile.facebook_link || '',
          province_city: buyerProfile.province_city,
          delivery_address: buyerProfile.delivery_address,
          delivery_note: buyerProfile.delivery_note || '',
        },
        delivery_company: deliveryCompany,
        subtotal_usd: subtotal,
        delivery_fee_usd: deliveryFee,
        total_usd: total,
        currency: payload.currency,
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

    return res.status(201).json({
      ok: true,
      configured: aba.configured,
      order: publicMallOrder(data),
    })
  } catch (error) {
    console.error('CREATE SHADOW MALL ORDER PAYMENT ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to create Shadow Mall payment',
    })
  }
}

export async function getShadowMallOrderStatus(req, res) {
  try {
    const userId = getUserId(req)
    const orderId = String(req.params.orderId || '').trim()

    if (!userId) return res.status(401).json({ ok: false, message: 'User is required' })

    const { data, error } = await supabase
      .from('shadow_mall_orders')
      .select('*')
      .eq('order_id', orderId)
      .eq('user_id', userId)
      .maybeSingle()

    if (error) throw error
    if (!data) return res.status(404).json({ ok: false, message: 'Shadow Mall order not found' })

    return res.status(200).json({ ok: true, order: publicMallOrder(data) })
  } catch (error) {
    console.error('GET SHADOW MALL ORDER STATUS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load Shadow Mall order status' })
  }
}

export async function getAdminShadowMallOrders(req, res) {
  try {
    const page = Math.max(Number(req.query.page || 1), 1)
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100)
    const status = String(req.query.status || 'under_review').trim()
    const q = String(req.query.q || '').trim()
    const from = (page - 1) * limit
    const to = from + limit - 1

    let query = supabase
      .from('shadow_mall_orders')
      .select('*', { count: 'exact' })

    if (status === 'all') {
      query = query
        .neq('status', 'waiting_payment')
        .neq('status', 'expired')
    } else if (ADMIN_ORDER_STATUSES.includes(status)) {
      query = query.eq('status', status)
    } else {
      query = query.eq('status', 'under_review')
    }

    if (q) {
      query = query.or(`order_id.ilike.%${q}%,aba_transaction_id.ilike.%${q}%`)
    }

    const { data, error, count } = await query
      .order('updated_at', { ascending: false })
      .range(from, to)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      orders: (data || []).map(publicMallOrder),
      page,
      limit,
      total: count || 0,
      total_pages: Math.max(Math.ceil((count || 0) / limit), 1),
      has_next: to + 1 < (count || 0),
      has_prev: page > 1,
    })
  } catch (error) {
    console.error('GET ADMIN SHADOW MALL ORDERS ERROR:', error)
    return res.status(500).json({ ok: false, message: error.message || 'Failed to load Shadow Mall orders' })
  }
}

export async function updateAdminShadowMallOrderStatus(req, res) {
  try {
    const orderId = String(req.params.orderId || '').trim()
    const status = String(req.body.status || '').trim()

    if (!ADMIN_ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ ok: false, message: 'Invalid order status' })
    }

    const { data, error } = await supabase
      .from('shadow_mall_orders')
      .update({
        status,
        admin_note: req.body.admin_note || null,
        updated_at: new Date().toISOString(),
      })
      .eq('order_id', orderId)
      .select('*')
      .single()

    if (error) throw error

    return res.status(200).json({ ok: true, order: publicMallOrder(data) })
  } catch (error) {
    console.error('UPDATE ADMIN SHADOW MALL ORDER STATUS ERROR:', error)
    return res.status(500).json({ ok: false, message: error.message || 'Failed to update Shadow Mall order' })
  }
}

export async function handleShadowMallAbaCallback(req, res) {
  try {
    const orderId = getCallbackOrderId(req.body)

    if (!orderId) return res.status(400).json({ ok: false, message: 'Missing order id' })

    const { data: order, error: orderError } = await supabase
      .from('shadow_mall_orders')
      .select('*')
      .eq('order_id', orderId)
      .maybeSingle()

    if (orderError) throw orderError
    if (!order) return res.status(404).json({ ok: false, message: 'Shadow Mall order not found' })

    await supabase.from('shadow_mall_order_callbacks').insert({
      order_id: orderId,
      payload: req.body,
      status_detected: isApprovedCallback(req.body) ? 'approved' : 'not_approved',
    })

    if (!isApprovedCallback(req.body)) {
      await supabase
        .from('shadow_mall_orders')
        .update({ callback_payload: req.body, updated_at: new Date().toISOString() })
        .eq('id', order.id)

      return res.status(200).json({ ok: true })
    }

    if (!callbackAmountMatches(order, req.body)) {
      await supabase
        .from('shadow_mall_orders')
        .update({
          status: 'amount_mismatch',
          callback_payload: req.body,
          updated_at: new Date().toISOString(),
        })
        .eq('id', order.id)

      return res.status(200).json({ ok: true })
    }

    if (order.status !== 'waiting_payment') return res.status(200).json({ ok: true })

    const { data: updatedOrder, error: updateError } = await supabase
      .from('shadow_mall_orders')
      .update({
        status: 'under_review',
        aba_transaction_id: req.body.transaction_id || req.body.tran_id || order.aba_transaction_id || null,
        callback_payload: req.body,
        paid_at: req.body.transaction_date ? new Date(req.body.transaction_date).toISOString() : new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', order.id)
      .eq('status', 'waiting_payment')
      .select('*')
      .single()

    if (updateError) throw updateError

    await deductShadowMallOrderStock(updatedOrder)

    return res.status(200).json({ ok: true })
  } catch (error) {
    console.error('SHADOW MALL ABA CALLBACK ERROR:', error)
    return res.status(500).json({ ok: false, message: error.message || 'Failed to process Shadow Mall ABA callback' })
  }
}
