import {
  BinanceClaimError,
  getBinanceCheckoutClaim,
  submitBinanceCheckoutClaim,
} from '../services/binanceCheckoutClaims.service.js'

const MESSAGES = {
  UNAUTHORIZED: 'Please log in to continue.',
  INVALID_ORDER_ID: 'Invalid Binance payment order.',
  INVALID_TRANSACTION_ID: 'Enter a valid Binance transaction ID.',
  CHECKOUT_NOT_FOUND: 'Payment order was not found.',
  CLAIM_NOT_FOUND: 'No payment report has been submitted for this order.',
  ORDER_ALREADY_CLAIMED: 'This order already has a payment report.',
  ORDER_NOT_CLAIMABLE: 'This order cannot accept a payment report.',
  CLAIM_WINDOW_CLOSED: 'The payment report window has closed. Please contact Admin.',
  TRANSACTION_ALREADY_CLAIMED: 'This transaction was already reported. Please contact Admin.',
}

function respondError(res, error) {
  if (error instanceof BinanceClaimError) {
    return res.status(error.status).json({
      ok: false,
      code: error.code,
      message: MESSAGES[error.code] || 'Unable to process payment report.',
    })
  }
  console.error('BINANCE CHECKOUT CLAIM ERROR:', String(error?.code || error?.name || 'UnknownError').slice(0, 80))
  return res.status(503).json({
    ok: false,
    code: 'BINANCE_CLAIM_UNAVAILABLE',
    message: 'Shadow payment service is temporarily unavailable. Please contact Admin.',
  })
}

function privateResponse(res) {
  res.set('Cache-Control', 'private, no-store')
  res.set('X-Content-Type-Options', 'nosniff')
}

export async function submitReaderBinanceClaim(req, res) {
  privateResponse(res)
  try {
    const claim = await submitBinanceCheckoutClaim({
      userId: req.user?.user_id || req.user?.id,
      orderId: req.params.orderId,
      transactionId: req.body?.transaction_id,
    })
    return res.status(202).json({
      ok: true,
      claim,
      message: 'Payment report received. Your payment is awaiting verification.',
    })
  } catch (error) {
    return respondError(res, error)
  }
}

export async function getReaderBinanceClaim(req, res) {
  privateResponse(res)
  try {
    const claim = await getBinanceCheckoutClaim({
      userId: req.user?.user_id || req.user?.id,
      orderId: req.params.orderId,
    })
    return res.status(200).json({ ok: true, claim })
  } catch (error) {
    return respondError(res, error)
  }
}
