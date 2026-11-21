import { listPublicAuthorPreOrders, getPublicAuthorPreOrder } from '../services/authorPreOrderPublicCatalog.service.js'
import { quoteAuthorPreOrder } from '../services/authorPreOrderCheckoutQuote.service.js'

function privateJson(res) {
  res.set('Cache-Control', 'no-store, max-age=0')
  res.set('Pragma', 'no-cache')
  res.set('X-Content-Type-Options', 'nosniff')
}

function fail(res, error, action) {
  const status = Number(error?.statusCode)
  const expected = Number.isInteger(status) && status >= 400 && status < 600
  if (!expected) console.error(`PRE_ORDER_READER_${action}_FAILED:`, String(error?.message || error))
  return res.status(expected ? status : 503).json({
    ok: false,
    code: expected ? error.code : 'PRE_ORDER_READER_UNAVAILABLE',
    message: expected ? error.message : 'Pre-order service is temporarily unavailable',
  })
}

export async function getPublicAuthorPreOrders(req, res) {
  privateJson(res)
  try {
    const result = await listPublicAuthorPreOrders(req.query)
    return res.status(200).json({ ok: true, ...result })
  } catch (error) {
    return fail(res, error, 'LIST')
  }
}

export async function getPublicAuthorPreOrderDetail(req, res) {
  privateJson(res)
  try {
    const record = await getPublicAuthorPreOrder(req.params.campaignId)
    return res.status(200).json({ ok: true, record })
  } catch (error) {
    return fail(res, error, 'DETAIL')
  }
}

export async function getPublicAuthorPreOrderQuote(req, res) {
  privateJson(res)
  try {
    const quote = await quoteAuthorPreOrder(req.params.campaignId, req.body)
    return res.status(200).json({ ok: true, quote })
  } catch (error) {
    return fail(res, error, 'QUOTE')
  }
}
