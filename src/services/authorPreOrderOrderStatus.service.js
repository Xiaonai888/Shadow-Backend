import { supabase } from '../config/supabase.js'
import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'

const ORDERS = 'author_preorder_orders'
const ITEMS = 'author_preorder_order_items'
const PAYMENT_STATUSES = new Set(['pending', 'paid', 'failed', 'expired', 'refunded'])
const FULFILLMENT_STATUSES = new Set(['awaiting_payment', 'reserved', 'production', 'shipping', 'completed', 'cancelled', 'delayed'])
const ORDER_FIELDS = [
  'id', 'campaign_id', 'author_page_id', 'buyer_user_id',
  'payment_status', 'fulfillment_status', 'subtotal_usd',
  'signature_fee_usd', 'delivery_fee_usd', 'total_usd',
  'signature_requested', 'paid_at', 'created_at', 'updated_at',
].join(',')
const ITEM_FIELDS = 'id,order_id,book_id,edition,quantity,unit_price_usd,book_title_snapshot'

function unavailable(error, scope) {
  if (!error) return
  console.error(`PRE_ORDER_BUYER_STATUS_${scope}:`, String(error?.message || error))
  throw preOrderError('PRE_ORDER_BUYER_STATUS_UNAVAILABLE', 'Could not load pre-order status', 503)
}

function amount(value, field) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > 9999999999 || !Number.isInteger(Math.round(number * 100))) {
    throw preOrderError('PRE_ORDER_BUYER_STATUS_INVALID', `Invalid stored ${field}`, 503)
  }
  return Math.round(number * 100) / 100
}

function normalizeItem(item) {
  const quantity = Number(item.quantity)
  if (!['standard', 'limited'].includes(item.edition) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) {
    throw preOrderError('PRE_ORDER_BUYER_STATUS_INVALID', 'Invalid stored book item', 503)
  }
  return {
    id: item.id,
    book_id: item.book_id,
    title: String(item.book_title_snapshot || '').slice(0, 180),
    edition: item.edition,
    quantity,
    unit_price_usd: amount(item.unit_price_usd, 'book price'),
  }
}

function normalizeOrder(row, items) {
  if (!PAYMENT_STATUSES.has(row.payment_status) || !FULFILLMENT_STATUSES.has(row.fulfillment_status)) {
    throw preOrderError('PRE_ORDER_BUYER_STATUS_INVALID', 'Invalid stored order state', 503)
  }
  return {
    id: row.id,
    campaign_id: row.campaign_id,
    author_page_id: row.author_page_id,
    payment_status: row.payment_status,
    fulfillment_status: row.fulfillment_status,
    subtotal_usd: amount(row.subtotal_usd, 'subtotal'),
    signature_fee_usd: amount(row.signature_fee_usd, 'signature fee'),
    delivery_fee_usd: amount(row.delivery_fee_usd, 'delivery fee'),
    total_usd: amount(row.total_usd, 'total'),
    signature_requested: row.signature_requested === true,
    paid_at: row.paid_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    items,
  }
}

async function fetchItems(orderIds) {
  if (!orderIds.length) return new Map()
  const { data, error } = await supabase.from(ITEMS)
    .select(ITEM_FIELDS)
    .in('order_id', orderIds)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
  unavailable(error, 'ITEMS')
  const result = new Map(orderIds.map(id => [id, []]))
  for (const item of data || []) {
    result.get(item.order_id)?.push(normalizeItem(item))
  }
  return result
}

export async function getReaderPreOrderStatus(buyerUserId, orderId) {
  const buyerId = preOrderUuid(buyerUserId, 'buyer ID')
  const id = preOrderUuid(orderId, 'order ID')
  const { data, error } = await supabase.from(ORDERS)
    .select(ORDER_FIELDS)
    .eq('id', id)
    .eq('buyer_user_id', buyerId)
    .maybeSingle()
  unavailable(error, 'DETAIL')
  if (!data) throw preOrderError('PRE_ORDER_BUYER_ORDER_NOT_FOUND', 'Pre-order was not found', 404)
  const items = await fetchItems([id])
  return normalizeOrder(data, items.get(id) || [])
}

export async function listReaderPreOrderStatuses(buyerUserId, { page = 1, limit = 12 } = {}) {
  const buyerId = preOrderUuid(buyerUserId, 'buyer ID')
  const currentPage = Number(page)
  const currentLimit = Number(limit)
  if (!Number.isSafeInteger(currentPage) || currentPage < 1 || currentPage > 10000 ||
      !Number.isSafeInteger(currentLimit) || currentLimit < 1 || currentLimit > 24) {
    throw preOrderError('PRE_ORDER_BUYER_INVALID_PAGE', 'Invalid order page or limit', 400)
  }
  const offset = (currentPage - 1) * currentLimit
  const { data, error, count } = await supabase.from(ORDERS)
    .select(ORDER_FIELDS, { count: 'exact' })
    .eq('buyer_user_id', buyerId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + currentLimit - 1)
  unavailable(error, 'LIST')
  const rows = data || []
  const itemsByOrder = await fetchItems(rows.map(row => row.id))
  const total = Number(count || 0)
  return {
    orders: rows.map(row => normalizeOrder(row, itemsByOrder.get(row.id) || [])),
    total,
    page: currentPage,
    limit: currentLimit,
    has_more: offset + rows.length < total,
  }
}
