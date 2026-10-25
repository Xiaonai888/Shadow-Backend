import {
  BinanceAdminReviewError,
  getBinanceCheckoutReview,
  listBinanceCheckoutReviews,
} from '../services/binanceCheckoutAdminReview.service.js'

const MESSAGES = {
  INVALID_PAGE: 'Invalid page number.',
  INVALID_STATUS: 'Invalid review status.',
  INVALID_ORDER_ID: 'Invalid Binance order ID.',
  CLAIM_NOT_FOUND: 'Binance payment report was not found.',
}

function responseHeaders(res) {
  res.set('Cache-Control', 'private, no-store')
  res.set('X-Content-Type-Options', 'nosniff')
}

function requireAdminRole(req, res) {
  const role = String(req.admin?.role || '').trim().toLowerCase()
  if (role === 'owner' || role === 'admin') return true
  res.status(403).json({ ok: false, message: 'Owner/Admin access required.' })
  return false
}

function fail(res, error) {
  if (error instanceof BinanceAdminReviewError) {
    return res.status(error.status).json({ ok: false, code: error.code, message: MESSAGES[error.code] || 'Invalid request.' })
  }
  console.error('BINANCE CHECKOUT ADMIN REVIEW:', String(error?.code || error?.name || 'Unexpected error').slice(0, 80))
  return res.status(503).json({ ok: false, code: 'REVIEW_UNAVAILABLE', message: 'Binance review information is temporarily unavailable.' })
}

export async function listAdminBinanceCheckoutReviews(req, res) {
  responseHeaders(res)
  if (!requireAdminRole(req, res)) return
  try {
    const result = await listBinanceCheckoutReviews({ page: req.query.page, status: req.query.status })
    return res.status(200).json({ ok: true, ...result })
  } catch (error) {
    return fail(res, error)
  }
}

export async function getAdminBinanceCheckoutReview(req, res) {
  responseHeaders(res)
  if (!requireAdminRole(req, res)) return
  try {
    const item = await getBinanceCheckoutReview(req.params.orderId)
    return res.status(200).json({ ok: true, item, read_only: true })
  } catch (error) {
    return fail(res, error)
  }
}
