import express from 'express'
import { rateLimit } from 'express-rate-limit'
import {
  BinanceReceiverUnavailableError,
  getVerifiedBinanceReceiver,
} from '../services/binanceReceiverGuard.service.js'

const router = express.Router()
const unavailableMessage = 'Shadow payment service is temporarily unavailable. Please contact Admin for assistance.'
const receiverReadLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'BINANCE_RECEIVER_RATE_LIMIT',
    message: 'Too many requests. Please try again shortly.',
  },
})

function preventCaching(res) {
  res.set('Cache-Control', 'no-store, max-age=0')
  res.set('Pragma', 'no-cache')
  res.set('X-Content-Type-Options', 'nosniff')
}

function sendUnavailable(res, error) {
  if (!(error instanceof BinanceReceiverUnavailableError)) {
    console.error('BINANCE RECEIVER ROUTE ERROR:', String(error?.name || 'UnknownError'))
  }
  return res.status(503).json({
    ok: false,
    code: 'BINANCE_RECEIVER_UNAVAILABLE',
    message: unavailableMessage,
  })
}

router.get('/receiver', receiverReadLimit, async (req, res) => {
  preventCaching(res)
  try {
    const { uid, name } = await getVerifiedBinanceReceiver()
    return res.status(200).json({
      ok: true,
      receiver: { uid, name },
      qr_path: '/api/purchase/binance/receiver/qr',
      checkout_ready: false,
    })
  } catch (error) {
    return sendUnavailable(res, error)
  }
})

router.get('/receiver/qr', receiverReadLimit, async (req, res) => {
  preventCaching(res)
  try {
    const { qrBytes, qrContentType } = await getVerifiedBinanceReceiver()
    res.set('Content-Type', qrContentType)
    res.set('Cross-Origin-Resource-Policy', 'cross-origin')
    return res.status(200).send(qrBytes)
  } catch (error) {
    return sendUnavailable(res, error)
  }
})

export default router
