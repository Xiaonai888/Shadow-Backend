import { supabase } from '../config/supabase.js'
import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'
import { prepareAuthorPreOrderReview } from './authorPreOrderOrderPreparation.service.js'
import { preOrderPaymentCents } from './authorPreOrderPaymentValidation.service.js'

function storageError(error, scope) {
  const code = String(error?.message || '').match(/PRE_ORDER_[A-Z0-9_]+/)?.[0]
  if (code) throw preOrderError(code, 'Could not reserve the requested pre-order stock', 409)
  console.error(`PRE_ORDER_STOCK_HOLD_${scope}:`, String(error?.code || 'unknown'))
  throw preOrderError('PRE_ORDER_STOCK_HOLD_UNAVAILABLE', 'Pre-order inventory is temporarily unavailable', 503)
}

export async function createHeldAuthorPreOrder(campaignId, buyerUserId, requestKey, input) {
  const campaign = preOrderUuid(campaignId, 'campaign ID')
  const buyer = preOrderUuid(buyerUserId, 'buyer ID')
  const key = preOrderUuid(requestKey, 'checkout request key')
  const review = await prepareAuthorPreOrderReview(campaign, buyer, input)
  if (review?.preview_only !== true || review.order_created !== false ||
      review.inventory_reserved !== false || review.payment_created !== false ||
      review.items?.length !== 1 || review.campaign_id !== campaign) {
    throw preOrderError('PRE_ORDER_HOLD_REVIEW_INVALID', 'Checkout selection is not valid', 503)
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

  const { data, error } = await supabase.rpc('author_preorder_create_held_checkout', {
    p_buyer_user_id: buyer,
    p_campaign_id: campaign,
    p_request_key: key,
    p_payload: payload,
  })
  if (error) storageError(error, 'CREATE')

  const orderId = preOrderUuid(data?.order_id, 'order ID')
  const totalCents = preOrderPaymentCents(data?.total_usd, 'stored checkout amount')
  const quotedCents = preOrderPaymentCents(review.pricing?.total_usd, 'quoted amount')
  const expiresAt = Date.parse(String(data?.hold_expires_at || ''))
  if (!totalCents || totalCents !== quotedCents ||
      data?.payment_status !== 'pending' || data?.hold_status !== 'held' ||
      data?.inventory_held !== true ||
      !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw preOrderError('PRE_ORDER_HOLD_RESULT_INVALID', 'Stock reservation cannot be confirmed; do not start payment', 409)
  }

  return {
    order_id: orderId,
    payment_status: 'pending',
    inventory_held: true,
    hold_expires_at: new Date(expiresAt).toISOString(),
    reused: data.reused === true,
    total_usd: totalCents / 100,
    review,
  }
}

export async function getAuthorPreOrderStockHold(orderId) {
  const id = preOrderUuid(orderId, 'order ID')
  const { data, error } = await supabase.from('author_preorder_stock_holds')
    .select('order_id,book_id,edition,quantity,status,held_at,expires_at,consumed_at,released_at')
    .eq('order_id', id).maybeSingle()
  if (error) storageError(error, 'READ')
  if (!data) throw preOrderError('PRE_ORDER_HOLD_NOT_FOUND', 'No stock hold was found', 404)
  return data
}
