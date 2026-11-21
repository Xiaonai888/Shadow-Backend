import { supabase } from '../config/supabase.js'
import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'
import { prepareAuthorPreOrderReview } from './authorPreOrderOrderPreparation.service.js'
import { preOrderPaymentCents } from './authorPreOrderPaymentValidation.service.js'

function rejectDatabase(error) {
  if (!error) return
  const code = String(error.message || '').match(/PRE_ORDER_[A-Z0-9_]+/)?.[0]
  if (code) {
    throw preOrderError(code, 'The pending checkout request could not be accepted', 409)
  }
  if (error.code === '23505') {
    throw preOrderError('PRE_ORDER_CHECKOUT_CONFLICT', 'Checkout already exists; use the same request key to retry', 409)
  }
  console.error('PRE_ORDER_PENDING_CHECKOUT_DB:', String(error.code || 'unknown'))
  throw preOrderError('PRE_ORDER_CHECKOUT_STORAGE_UNAVAILABLE', 'Could not create pending pre-order', 503)
}

export async function createAuthorPreOrderPendingOrder(campaignId, buyerUserId, requestKey, input) {
  const id = preOrderUuid(campaignId, 'campaign ID')
  const buyerId = preOrderUuid(buyerUserId, 'buyer account ID')
  const key = preOrderUuid(requestKey, 'idempotency key')
  const review = await prepareAuthorPreOrderReview(id, buyerId, input)
  if (!review?.preview_only || review.order_created !== false || review.payment_created !== false ||
      review.inventory_reserved !== false || review.items?.length !== 1 || review.campaign_id !== id) {
    throw preOrderError('PRE_ORDER_CHECKOUT_REVIEW_INVALID', 'Checkout review is unavailable', 503)
  }

  const item = review.items[0]
  const payload = {
    book_id: preOrderUuid(item.book_id, 'book ID'),
    edition: item.edition,
    quantity: item.quantity,
    delivery_company_key: review.delivery_snapshot?.company?.company_key,
    buyer_snapshot: review.buyer_snapshot,
    signature_requested: review.signature_requested === true,
    signature_name: review.signature_name || '',
    buyer_note: review.buyer_note || '',
  }
  const { data, error } = await supabase.rpc('author_preorder_create_pending_checkout', {
    p_buyer_user_id: buyerId,
    p_campaign_id: id,
    p_request_key: key,
    p_payload: payload,
  })
  rejectDatabase(error)

  const orderId = preOrderUuid(data?.order_id, 'created order ID')
  const total = preOrderPaymentCents(data?.total_usd, 'pending order total')
  const quoted = preOrderPaymentCents(review.pricing?.total_usd, 'checkout review total')
  if (data?.payment_status !== 'pending' || (data?.reused !== true && data?.reused !== false) ||
      !total || total !== quoted) {
    throw preOrderError('PRE_ORDER_CHECKOUT_PRICE_CHANGED', 'Checkout amount or order state has changed; refresh before paying', 409)
  }

  return {
    order_id: orderId,
    reused: data.reused,
    payment_status: 'pending',
    total_usd: total / 100,
    review,
  }
}
