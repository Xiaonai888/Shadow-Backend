import { supabase } from '../config/supabase.js'

const MAX_PRODUCTS = 30
const PAID_STATUSES = new Set(['confirmed', 'preparing', 'shipped', 'completed'])
const ENDED_STATUSES = new Set(['cancelled', 'canceled', 'rejected', 'refunded', 'expired', 'failed', 'amount_mismatch'])

function normalizedIds(values) {
  if (!Array.isArray(values) || !values.length || values.length > MAX_PRODUCTS) {
    const error = new Error('Select between 1 and 30 products.')
    error.statusCode = 400
    throw error
  }
  const ids = values.map((value) => String(value || '').trim())
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (ids.some((id) => !uuid.test(id))) {
    const error = new Error('Invalid product ID.')
    error.statusCode = 400
    throw error
  }
  return [...new Set(ids)]
}

function normalizeOrder(order) {
  return {
    order_id: order.order_id || '',
    status: String(order.status || '').toLowerCase(),
    payment_status: String(order.payment_status || '').toLowerCase(),
    pdf_unlock_status: String(order.pdf_unlock_status || '').toLowerCase(),
    created_at: order.created_at || null,
  }
}

export async function getAuthorStorePdfOwnership(buyerId, rawProductIds) {
  const userId = String(buyerId || '').trim()
  if (!userId) {
    const error = new Error('Sign in required.')
    error.statusCode = 401
    throw error
  }
  const ids = normalizedIds(rawProductIds)
  const { data: products, error: productsError } = await supabase
    .from('author_store_products')
    .select('id, product_type')
    .in('id', ids)
  if (productsError) throw productsError
  if ((products || []).length !== ids.length) {
    const error = new Error('One or more products were not found.')
    error.statusCode = 404
    throw error
  }
  const pdfIds = new Set((products || [])
    .filter((product) => String(product.product_type || '').toLowerCase() === 'pdf')
    .map((product) => String(product.id)))
  const state = new Map(ids.map((id) => [id, {
    product_id: id,
    product_type: pdfIds.has(id) ? 'pdf' : 'book',
    state: 'available',
    order_id: null,
  }]))
  if (!pdfIds.size) return [...state.values()]

  const activeIds = [...pdfIds]
  const [grantsResult, ordersResult] = await Promise.all([
    supabase
      .from('author_store_reader_downloads')
      .select('product_id, order_id')
      .eq('buyer_id', userId)
      .in('product_id', activeIds),
    supabase
      .from('author_store_orders')
      .select('id,order_id,status,payment_status,pdf_unlock_status,created_at,items:author_store_order_items!inner(product_id,product_type)')
      .eq('buyer_id', userId)
      .in('items.product_id', activeIds)
      .order('created_at', { ascending: false })
      .limit(300),
  ])
  if (grantsResult.error) throw grantsResult.error
  if (ordersResult.error) throw ordersResult.error

  const grants = grantsResult.data || []
  const orders = ordersResult.data || []
  const grantedOrderIds = [...new Set(grants.map((grant) => grant.order_id).filter(Boolean))]
  const { data: linkedOrders, error: linkedError } = grantedOrderIds.length
    ? await supabase
      .from('author_store_orders')
      .select('id,order_id,status,payment_status,pdf_unlock_status,created_at')
      .eq('buyer_id', userId)
      .in('id', grantedOrderIds)
    : { data: [], error: null }
  if (linkedError) throw linkedError
  const linkedMap = new Map((linkedOrders || []).map((order) => [String(order.id), order]))

  for (const id of activeIds) {
    const itemOrders = orders.filter((order) => Array.isArray(order.items)
      && order.items.some((item) => String(item.product_id) === id
        && String(item.product_type || '').toLowerCase() === 'pdf'))
    const grant = grants.find((row) => String(row.product_id) === id)
    const linkedOrder = grant ? linkedMap.get(String(grant.order_id)) : null
    const paidOrder = itemOrders.find((order) => order.payment_status === 'paid'
      && PAID_STATUSES.has(String(order.status || '').toLowerCase())
      && String(order.pdf_unlock_status || '').toLowerCase() === 'unlocked')
    const anyPaid = itemOrders.find((order) => String(order.payment_status || '').toLowerCase() === 'paid')

    if (grant && linkedOrder
      && String(linkedOrder.payment_status || '').toLowerCase() === 'paid'
      && PAID_STATUSES.has(String(linkedOrder.status || '').toLowerCase())
      && String(linkedOrder.pdf_unlock_status || '').toLowerCase() === 'unlocked') {
      state.set(id, { ...state.get(id), state: 'purchased', ...normalizeOrder(linkedOrder) })
    } else if (grant || paidOrder || anyPaid) {
      const source = linkedOrder || paidOrder || anyPaid
      state.set(id, {
        ...state.get(id),
        state: 'access_recovery',
        ...(source ? normalizeOrder(source) : {}),
      })
    } else {
      const pending = itemOrders.find((order) => !ENDED_STATUSES.has(String(order.status || '').toLowerCase()))
      if (pending) {
        state.set(id, { ...state.get(id), state: 'checking_payment', ...normalizeOrder(pending) })
      }
    }
  }
  return [...state.values()]
}

export function authorStorePdfCheckoutDecision(states) {
  const restricted = states.filter((item) => item.product_type === 'pdf' && item.state !== 'available')
  if (!restricted.length) return null
  const purchased = restricted.filter((item) => item.state === 'purchased')
  const recovery = restricted.filter((item) => item.state === 'access_recovery')
  const pending = restricted.filter((item) => item.state === 'checking_payment')
  const code = purchased.length ? 'PDF_ALREADY_PURCHASED'
    : recovery.length ? 'PDF_ACCESS_RECOVERY_REQUIRED'
      : 'PDF_PAYMENT_PENDING'
  const message = purchased.length
    ? 'You already own this PDF. Open it from your Library.'
    : recovery.length
      ? 'Your payment needs PDF access recovery. Do not pay again.'
      : 'Your previous PDF payment is being checked. Do not pay again.'
  return {
    ok: false,
    code,
    message,
    library_path: '/library',
    products: restricted,
    pending_order_id: pending[0]?.order_id || null,
  }
}
