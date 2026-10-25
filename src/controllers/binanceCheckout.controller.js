import { BinanceReceiverUnavailableError } from '../services/binanceReceiverGuard.service.js'
import {
  BinanceCheckoutError,
  cancelBinanceCheckoutOrder,
  createBinanceCheckoutOrder,
  getBinanceCheckoutOrder,
} from '../services/binanceCheckout.service.js'

const UNAVAILABLE = 'Shadow payment service is temporarily unavailable. Please contact Admin for assistance.'
const ERRORS = {
  UNAUTHORIZED: 'Please log in to continue.',
  INVALID_PACKAGE: 'Invalid purchase package.',
  INVALID_ORDER_ID: 'Invalid payment order.',
  CHECKOUT_NOT_FOUND: 'Payment order was not found.',
  ACTIVE_CHECKOUT_EXISTS: 'A Binance payment order is already active. Finish or cancel it first.',
}

function noStore(res) {
  res.set('Cache-Control', 'private, no-store')
  res.set('X-Content-Type-Options', 'nosniff')
}

function sendError(res, error) {
  if (error instanceof BinanceReceiverUnavailableError) {
    return res.status(503).json({ ok: false, code: 'BINANCE_RECEIVER_UNAVAILABLE', message: UNAVAILABLE })
  }
  if (error instanceof BinanceCheckoutError) {
    return res.status(error.status).json({
      ok: false,
      code: error.code,
      message: ERRORS[error.code] || 'Unable to prepare Binance payment.',
    })
  }
  console.error('BINANCE CHECKOUT ERROR:', String(error?.code || error?.name || 'UnknownError').slice(0,80))
  return res.status(503).json({ ok: false, code: 'BINANCE_CHECKOUT_UNAVAILABLE', message: UNAVAILABLE })
}

function readerId(req) {
  return req.user?.user_id || req.user?.id || ''
}

export async function createBinanceCheckout(req, res) {
  noStore(res)
  try {
    const order = await createBinanceCheckoutOrder({
      userId: readerId(req),
      packageUsd: req.body?.package_usd,
    })
    return res.status(201).json({ ok: true, order })
  } catch (error) {
    return sendError(res, error)
  }
}

export async function getBinanceCheckout(req, res) {
  noStore(res)
  try {
    const order = await getBinanceCheckoutOrder({
      userId: readerId(req),
      orderId: req.params.orderId,
    })
    return res.status(200).json({ ok: true, order })
  } catch (error) {
    return sendError(res, error)
  }
}

export async function cancelBinanceCheckout(req, res) {
  noStore(res)
  try {
    const order = await cancelBinanceCheckoutOrder({
      userId: readerId(req),
      orderId: req.params.orderId,
    })
    return res.status(200).json({ ok: true, order })
  } catch (error) {
    return sendError(res, error)
  }
}
