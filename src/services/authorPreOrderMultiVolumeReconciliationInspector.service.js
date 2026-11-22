import { supabase } from '../config/supabase.js'
import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'
import { preOrderPaymentCents } from './authorPreOrderPaymentValidation.service.js'
import { classifyAuthorPreOrderReconciliationHold } from './authorPreOrderReconciliationHoldClassifier.service.js'

function requireDatabase(result, label) {
  if (result.error) {
    console.error(`PRE_ORDER_MULTI_RECON_INSPECT_${label}_DB:`, String(result.error.code || 'unknown'))
    throw preOrderError('PRE_ORDER_MULTI_RECON_INSPECT_UNAVAILABLE', 'Could not inspect multi-volume payment', 503)
  }
  return result.data
}

function cents(value) {
  try { return preOrderPaymentCents(value, 'stored amount') } catch { return null }
}

function issueOnce(issues, code) {
  if (!issues.includes(code)) issues.push(code)
}

export async function inspectAuthorPreOrderMultiVolumeReconciliation(orderId, { now = Date.now() } = {}) {
  const id = preOrderUuid(orderId, 'order ID').toLowerCase()
  if (!Number.isFinite(now)) {
    throw preOrderError('PRE_ORDER_MULTI_RECON_TIME_INVALID', 'Invalid inspection time', 400)
  }
  const classification = await classifyAuthorPreOrderReconciliationHold(id)
  if (classification.hold_type !== 'multi_volume') {
    throw preOrderError('PRE_ORDER_MULTI_RECON_HOLD_TYPE_MISMATCH', 'Order does not have multi-volume stock holds', 409)
  }
  const order = requireDatabase(await supabase.from('author_preorder_orders')
    .select('id,author_page_id,campaign_id,payment_status,fulfillment_status,paid_at,payment_reference,signature_requested,subtotal_usd,signature_fee_usd,delivery_fee_usd,total_usd')
    .eq('id', id).maybeSingle(), 'ORDER')
  if (!order) {
    throw preOrderError('PRE_ORDER_MULTI_RECON_ORDER_NOT_FOUND', 'Order was not found', 404)
  }

  const [holdsResult, itemsResult, intentResult, ledgerResult, reviewResult] = await Promise.all([
    supabase.from('author_preorder_volume_holds')
      .select('book_id,edition,quantity,status,expires_at,consumed_at,released_at')
      .eq('order_id', id).order('book_id', { ascending: true }).limit(11),
    supabase.from('author_preorder_order_items')
      .select('book_id,edition,quantity,unit_price_usd')
      .eq('order_id', id).limit(11),
    supabase.from('author_preorder_payment_intents')
      .select('merchant_transaction_id,currency,expected_amount_usd,expires_at,finalized_at')
      .eq('order_id', id).maybeSingle(),
    supabase.from('author_preorder_fee_ledger')
      .select('author_page_id,successful_order_number,service_fee_usd')
      .eq('order_id', id).maybeSingle(),
    supabase.from('author_preorder_terminal_reviews')
      .select('merchant_transaction_id,released_at,review_count')
      .eq('order_id', id).maybeSingle(),
  ])
  const holds = requireDatabase(holdsResult, 'HOLDS')
  const items = requireDatabase(itemsResult, 'ITEMS')
  const intent = requireDatabase(intentResult, 'INTENT')
  const ledger = requireDatabase(ledgerResult, 'LEDGER')
  const review = requireDatabase(reviewResult, 'REVIEW')
  if (!Array.isArray(holds) || !Array.isArray(items)) {
    throw preOrderError('PRE_ORDER_MULTI_RECON_ROWS_INVALID', 'Stock hold or order item data is invalid', 503)
  }

  const issues = []
  if (holds.length < 1 || holds.length > 10 || items.length !== holds.length ||
      holds.length !== classification.item_count) {
    issueOnce(issues, 'PRE_ORDER_MULTI_RECON_ITEM_COUNT_MISMATCH')
  }
  const byBook = new Map()
  let subtotal = 0
  for (const item of items) {
    const bookId = String(item?.book_id || '').toLowerCase()
    const quantity = Number(item?.quantity)
    const unit = cents(item?.unit_price_usd)
    if (!bookId || byBook.has(bookId) || !['standard', 'limited'].includes(item?.edition) ||
        !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99 ||
        unit === null || unit < 1 || !Number.isSafeInteger(unit * quantity)) {
      issueOnce(issues, 'PRE_ORDER_MULTI_RECON_ITEMS_INVALID')
      continue
    }
    byBook.set(bookId, item)
    subtotal += unit * quantity
  }
  const storedSubtotal = cents(order.subtotal_usd)
  const storedTotal = cents(order.total_usd)
  const signatureFee = cents(order.signature_fee_usd)
  const deliveryFee = cents(order.delivery_fee_usd)
  if (byBook.size !== items.length || !Number.isSafeInteger(subtotal) ||
      storedSubtotal === null || storedTotal === null ||
      signatureFee === null || deliveryFee === null ||
      storedSubtotal !== subtotal || storedTotal !== subtotal + signatureFee + deliveryFee ||
      storedTotal < 1 || (!order.signature_requested && signatureFee !== 0)) {
    issueOnce(issues, 'PRE_ORDER_MULTI_RECON_AMOUNT_MISMATCH')
  }

  const states = new Set()
  const expiries = []
  const seenHolds = new Set()
  for (const hold of holds) {
    const bookId = String(hold?.book_id || '').toLowerCase()
    const item = byBook.get(bookId)
    const expiry = Date.parse(String(hold?.expires_at || ''))
    if (!bookId || seenHolds.has(bookId) || !item ||
        item.edition !== hold.edition || Number(item.quantity) !== Number(hold.quantity)) {
      issueOnce(issues, 'PRE_ORDER_MULTI_RECON_HOLD_ITEM_MISMATCH')
    }
    if (!Number.isFinite(expiry)) {
      issueOnce(issues, 'PRE_ORDER_MULTI_RECON_HOLD_EXPIRY_INVALID')
    } else {
      expiries.push(expiry)
    }
    seenHolds.add(bookId)
    states.add(hold?.status)
    if (hold?.status === 'held' && (hold.consumed_at || hold.released_at) ||
        hold?.status === 'consumed' && (!hold.consumed_at || hold.released_at) ||
        hold?.status === 'released' && (!hold.released_at || hold.consumed_at)) {
      issueOnce(issues, 'PRE_ORDER_MULTI_RECON_HOLD_STATE_INVALID')
    }
  }
  if (expiries.length === holds.length && expiries.length > 1 &&
      Math.max(...expiries) - Math.min(...expiries) > 120_000) {
    issueOnce(issues, 'PRE_ORDER_MULTI_RECON_HOLD_EXPIRY_MISMATCH')
  }
  if (states.size !== 1 || !['held', 'consumed', 'released'].includes([...states][0])) {
    issueOnce(issues, 'PRE_ORDER_MULTI_RECON_HOLD_STATES_MIXED')
  }
  const holdStatus = states.size === 1 ? [...states][0] : 'mixed'
  if (intent && (intent.currency !== 'USD' || cents(intent.expected_amount_usd) !== cents(order.total_usd) ||
      !intent.merchant_transaction_id || !Number.isFinite(Date.parse(String(intent.expires_at || ''))))) {
    issueOnce(issues, 'PRE_ORDER_MULTI_RECON_INTENT_INVALID')
  }
  if (order.payment_reference && (!intent || order.payment_reference !== intent.merchant_transaction_id)) {
    issueOnce(issues, 'PRE_ORDER_MULTI_RECON_REFERENCE_MISMATCH')
  }
  if (ledger && (ledger.author_page_id !== order.author_page_id ||
      !Number.isSafeInteger(Number(ledger.successful_order_number)) || Number(ledger.successful_order_number) < 1)) {
    issueOnce(issues, 'PRE_ORDER_MULTI_RECON_LEDGER_INVALID')
  }
  if ((review?.released_at && holdStatus !== 'released') ||
      (review && intent && review.merchant_transaction_id !== intent.merchant_transaction_id)) {
    issueOnce(issues, 'PRE_ORDER_MULTI_RECON_TERMINAL_MISMATCH')
  }
  if (order.payment_status === 'paid') {
    if (!order.paid_at || !ledger || !intent || holdStatus !== 'consumed' || !order.payment_reference) {
      issueOnce(issues, 'PRE_ORDER_MULTI_RECON_PAID_INCOMPLETE')
    }
  } else if (order.payment_status === 'pending') {
    if (order.paid_at || ledger || holdStatus !== 'held' || order.fulfillment_status !== 'awaiting_payment' ||
        review?.released_at || intent?.finalized_at) {
      issueOnce(issues, 'PRE_ORDER_MULTI_RECON_PENDING_MISMATCH')
    }
  } else if (order.payment_status === 'expired') {
    if (order.paid_at || ledger || holdStatus !== 'released' || order.fulfillment_status !== 'cancelled') {
      issueOnce(issues, 'PRE_ORDER_MULTI_RECON_EXPIRED_MISMATCH')
    }
  } else {
    issueOnce(issues, 'PRE_ORDER_MULTI_RECON_TERMINAL_UNKNOWN')
  }

  const holdExpired = expiries.length === holds.length && holds.length > 0 &&
    expiries.every(time => time <= now)
  return {
    order_id: id,
    hold_type: 'multi_volume',
    item_count: items.length,
    payment_status: order.payment_status,
    hold_status: holdStatus,
    hold_expired: holdExpired,
    hold_expires_at: expiries.length === holds.length && holds.length > 0
      ? new Date(Math.max(...expiries)).toISOString() : null,
    has_payment_intent: Boolean(intent),
    has_fee_ledger: Boolean(ledger),
    has_terminal_review: Boolean(review),
    issues,
    requires_manual_review: issues.length > 0,
    can_check_provider: issues.length === 0 && order.payment_status === 'pending' &&
      holdStatus === 'held' && Boolean(intent),
    can_release_without_intent: issues.length === 0 && order.payment_status === 'pending' &&
      holdStatus === 'held' && holdExpired && !intent,
  }
}
