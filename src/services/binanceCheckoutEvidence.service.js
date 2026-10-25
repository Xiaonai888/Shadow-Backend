const DECIMAL_RE = /^(?:0|[1-9]\d{0,17})(?:\.\d{1,8})?$/

function amountUnits(value) {
  const valueString = String(value ?? '').trim()
  if (!DECIMAL_RE.test(valueString)) return null
  const [whole, fraction = ''] = valueString.split('.')
  return BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, '0'))
}

function evidenceState(order, claim, receipt, creditedAction, creditedOrder) {
  if (!order) return 'order_missing'
  if (!claim) return 'claim_missing'
  if (creditedAction || (creditedOrder && creditedOrder.id !== order.id)) return 'transaction_already_credited'
  if (claim.review_status !== 'submitted' || order.status !== 'pending_review') return 'not_pending_review'
  if (!receipt) return 'receipt_not_found'
  if (receipt.currency !== 'USDT') return 'currency_mismatch'
  const paid = amountUnits(receipt.amount)
  const required = amountUnits(order.amount_usdt)
  if (paid === null || paid <= 0n || required === null || paid !== required) return 'amount_mismatch'
  const receivedAt = Number(receipt.transaction_time_ms)
  const createdAt = Date.parse(order.created_at)
  const expiresAt = Date.parse(order.expires_at)
  if (!Number.isSafeInteger(receivedAt) || !Number.isFinite(createdAt) || !Number.isFinite(expiresAt)
    || receivedAt < createdAt - 60000 || receivedAt > expiresAt + 600000) return 'time_mismatch'
  return 'identity_verification_required'
}

export function evaluateBinanceCheckoutEvidence({ claim, order, receipt, creditedAction, creditedOrder }) {
  const status = evidenceState(order, claim, receipt, creditedAction, creditedOrder)
  const paid = receipt ? amountUnits(receipt.amount) : null
  const required = order ? amountUnits(order.amount_usdt) : null
  return {
    status,
    receipt_found: Boolean(receipt),
    currency_matches: Boolean(receipt && receipt.currency === 'USDT'),
    income_recorded: Boolean(receipt && paid !== null && paid > 0n),
    amount_matches: Boolean(receipt && paid !== null && required !== null && paid === required),
    receiver_identity_verified: false,
    shadow_recipient_verified: false,
    official_receipt_independently_verified: false,
    payment_approved: false,
    automatic_credit_enabled: false,
    review_required: true,
  }
}
