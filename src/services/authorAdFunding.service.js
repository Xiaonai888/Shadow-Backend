import { createHmac } from 'node:crypto'
import { supabase } from '../config/supabase.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PROVIDER = /^[a-z][a-z0-9_]{1,39}$/
const REFERENCE = /^[^\s\x00-\x1f\x7f]{6,160}$/
const SETTLED_STATUSES = new Set(['settled', 'paid', 'succeeded', 'success', 'completed'])

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function verifiedMoney(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 1000000
}

function paymentKey(provider, reference) {
  const secret = process.env.JWT_SECRET
  if (!secret || secret.length < 16) {
    throw new Error('Author ad funding idempotency is not configured')
  }
  return createHmac('sha256', secret)
    .update('shadow-author-ad-verified-funding-v1:')
    .update(provider)
    .update(':')
    .update(reference)
    .digest('hex')
}

function fundingError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

export async function recordSettledAuthorAdPayment({
  campaignId,
  paymentProvider,
  paymentReference,
  verifyPayment,
}) {
  const id = text(campaignId)
  const provider = text(paymentProvider).toLowerCase()
  const reference = text(paymentReference)

  if (!UUID.test(id) || !PROVIDER.test(provider) || !REFERENCE.test(reference)) {
    throw fundingError('INVALID_AUTHOR_AD_PAYMENT', 'Invalid author ad funding reference')
  }
  if (typeof verifyPayment !== 'function') {
    throw fundingError('PAYMENT_VERIFIER_REQUIRED', 'A trusted payment verifier is required')
  }

  const verified = await verifyPayment({
    campaignId: id,
    provider,
    reference,
  })

  if (!verified || typeof verified !== 'object' || Array.isArray(verified)
    || verified.verified !== true
    || !SETTLED_STATUSES.has(text(verified.status).toLowerCase())
    || verified.refunded === true
    || verified.disputed === true
    || text(verified.campaignId) !== id
    || text(verified.provider).toLowerCase() !== provider
    || text(verified.reference) !== reference
    || text(verified.currency).toUpperCase() !== 'USD'
    || !verifiedMoney(verified.amountCents)) {
    throw fundingError('PAYMENT_NOT_VERIFIED', 'Payment is not verified for this campaign')
  }

  const verifiedAt = text(verified.verifiedAt)
  const checkedAt = verifiedAt ? Date.parse(verifiedAt) : Date.now()
  if (!Number.isFinite(checkedAt) || checkedAt > Date.now() + 60000) {
    throw fundingError('INVALID_PAYMENT_TIME', 'Invalid verified payment timestamp')
  }

  const { data, error } = await supabase.rpc('record_author_ad_verified_funding_v1', {
    p_campaign_id: id,
    p_payment_provider: provider,
    p_payment_reference: reference,
    p_idempotency_key: paymentKey(provider, reference),
    p_amount_cents: verified.amountCents,
    p_metadata: {
      payment_currency: 'USD',
      verified_at: new Date(checkedAt).toISOString(),
    },
  })

  if (error) {
    if (error.code === 'PGRST202' || error.code === '42883') {
      throw fundingError('AUTHOR_AD_FUNDING_SQL_REQUIRED', 'Author ad funding SQL is not installed')
    }
    throw error
  }

  const result = Array.isArray(data) ? data[0] : data
  if (!result || result.campaign_id !== id || !UUID.test(String(result.ledger_id || ''))
    || !Number.isSafeInteger(Number(result.funded_cents))
    || !Number.isSafeInteger(Number(result.funding_remaining_cents))) {
    throw fundingError('INVALID_AUTHOR_AD_FUNDING_RESULT', 'Invalid author ad funding response')
  }

  return {
    recorded: result.recorded === true,
    campaignId: result.campaign_id,
    ledgerId: result.ledger_id,
    status: result.campaign_status,
    fundedCents: Number(result.funded_cents),
    remainingCents: Number(result.funding_remaining_cents),
  }
}
