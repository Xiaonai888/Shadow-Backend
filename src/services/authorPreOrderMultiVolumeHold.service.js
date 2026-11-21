import { supabase } from '../config/supabase.js'
import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'
import { parseAuthorPreOrderBuyerInput } from './authorPreOrderBuyerInput.service.js'
import { parseAuthorPreOrderVolumeSelection } from './authorPreOrderVolumeSelection.service.js'
import { quoteAuthorPreOrderVolumes } from './authorPreOrderVolumeQuote.service.js'
import { preOrderPaymentCents } from './authorPreOrderPaymentValidation.service.js'

function databaseError(error) {
  const code = String(error?.message || '').match(/PRE_ORDER_[A-Z0-9_]+/)?.[0]
  if (code) throw preOrderError(code, 'The selected volumes could not be reserved', 409)
  console.error('PRE_ORDER_MULTI_HOLD_DB:', String(error?.code || 'unknown'))
  throw preOrderError('PRE_ORDER_MULTI_HOLD_UNAVAILABLE', 'Pre-order stock reservation is unavailable', 503)
}

export async function createHeldAuthorPreOrderVolumes(campaignId, buyerUserId, requestKey, rawInput) {
  const campaign = preOrderUuid(campaignId, 'campaign ID').toLowerCase()
  const buyer = preOrderUuid(buyerUserId, 'buyer account ID').toLowerCase()
  const request = preOrderUuid(requestKey, 'checkout request key').toLowerCase()
  const selection = parseAuthorPreOrderVolumeSelection(rawInput)
  const information = parseAuthorPreOrderBuyerInput(rawInput, {
    signatureRequested: selection.signature_requested,
  })
  const quote = await quoteAuthorPreOrderVolumes(campaign, selection)
  if (quote?.campaign_id !== campaign || quote.quote_only !== true ||
      quote.inventory_reserved !== false || quote.payment_created !== false ||
      quote.order_created !== false || quote.currency !== 'USD' ||
      quote.items?.length !== selection.items.length ||
      quote.delivery_company?.company_key !== selection.delivery_company_key ||
      quote.signature_requested !== selection.signature_requested) {
    throw preOrderError('PRE_ORDER_MULTI_HOLD_QUOTE_INVALID', 'Volume price preview could not be confirmed', 503)
  }

  const selected = new Map(selection.items.map(item => [item.book_id, item]))
  for (const row of quote.items) {
    const item = selected.get(String(row.book_id || '').toLowerCase())
    if (!item || item.quantity !== row.quantity || item.edition !== row.edition) {
      throw preOrderError('PRE_ORDER_MULTI_HOLD_QUOTE_INVALID', 'Quoted books do not match the selection', 503)
    }
  }

  const payload = {
    items: selection.items,
    delivery_company_key: selection.delivery_company_key,
    signature_requested: selection.signature_requested,
    buyer_snapshot: information.buyer,
    signature_name: information.signature_name,
    buyer_note: information.buyer_note,
  }
  const { data, error } = await supabase.rpc('author_preorder_create_multivolume_held_checkout', {
    p_buyer_user_id: buyer,
    p_campaign_id: campaign,
    p_request_key: request,
    p_payload: payload,
  })
  if (error) databaseError(error)
  const id = preOrderUuid(data?.order_id, 'created order ID').toLowerCase()
  const totalCents = preOrderPaymentCents(data?.total_usd, 'stored order amount')
  const quotedCents = preOrderPaymentCents(quote.total_usd, 'quoted amount')
  const expires = Date.parse(String(data?.hold_expires_at || ''))
  if (!totalCents || quotedCents !== totalCents ||
      data?.payment_status !== 'pending' || data?.inventory_held !== true ||
      data?.hold_status !== 'held' || ![true, false].includes(data?.reused) ||
      Number(data?.item_count) !== selection.items.length ||
      !Number.isFinite(expires) || expires <= Date.now()) {
    throw preOrderError('PRE_ORDER_MULTI_HOLD_REVIEW_CHANGED', 'Stock or price changed; do not start payment', 409)
  }
  return {
    order_id: id,
    payment_status: 'pending',
    reused: data.reused,
    inventory_held: true,
    hold_expires_at: new Date(expires).toISOString(),
    item_count: selection.items.length,
    total_usd: totalCents / 100,
    review: {
      ...quote,
      buyer_snapshot: information.buyer,
      signature_name: information.signature_name,
      buyer_note: information.buyer_note,
      preview_only: false,
      inventory_reserved: true,
      order_created: true,
      payment_created: false,
    },
  }
}

export async function getAuthorPreOrderMultiVolumeHolds(orderId) {
  const id = preOrderUuid(orderId, 'order ID').toLowerCase()
  const { data, error } = await supabase.from('author_preorder_volume_holds')
    .select('order_id,book_id,edition,quantity,status,held_at,expires_at,consumed_at,released_at')
    .eq('order_id', id)
    .order('book_id', { ascending: true })
    .limit(11)
  if (error) databaseError(error)
  if (!Array.isArray(data) || data.length < 1 || data.length > 10) {
    throw preOrderError('PRE_ORDER_MULTI_HOLDS_INVALID', 'Multi-volume stock hold record is incomplete', 503)
  }
  return data
}
