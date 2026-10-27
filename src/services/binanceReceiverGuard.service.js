import { createHash, timingSafeEqual } from 'node:crypto'

const QR_SOURCE_URL = 'https://raw.githubusercontent.com/Xiaonai888/Web-React-2/main/public/assets/Icons/Picture/Binance%20QR.webp'
const QR_MAX_BYTES = 512 * 1024
const QR_CACHE_MS = 5 * 60 * 1000
const OFFICIAL_RECEIVER_UID = '514018161'
const OFFICIAL_RECEIVER_NAME = 'Shadow12226'

let cache = null
let pending = null

export class BinanceReceiverUnavailableError extends Error {
  constructor() {
    super('Binance payment is temporarily unavailable')
    this.name = 'BinanceReceiverUnavailableError'
    this.statusCode = 503
  }
}

function readReceiverSettings() {
  const enabled = String(process.env.BINANCE_PAYMENT_ENABLED || '').trim() === 'true'
  const uid = String(process.env.BINANCE_RECEIVER_UID || '').trim()
  const name = String(process.env.BINANCE_RECEIVER_NAME || '').trim()
  const expectedHash = String(process.env.BINANCE_QR_SHA256 || '').trim().toLowerCase()

  if (!enabled || uid !== OFFICIAL_RECEIVER_UID || name !== OFFICIAL_RECEIVER_NAME || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new BinanceReceiverUnavailableError()
  }

  return { uid, name, expectedHash, cacheKey: `${uid}\u0000${name}\u0000${expectedHash}` }
}

async function verifyReceiverQr(settings) {
  let response
  try {
    response = await fetch(QR_SOURCE_URL, {
      method: 'GET',
      headers: { Accept: 'image/webp' },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    })
  } catch {
    throw new BinanceReceiverUnavailableError()
  }

  const declaredLength = Number(response.headers.get('content-length'))
  if (!response.ok || (Number.isFinite(declaredLength) && declaredLength > QR_MAX_BYTES)) {
    throw new BinanceReceiverUnavailableError()
  }

  let bytes
  try {
    bytes = Buffer.from(await response.arrayBuffer())
  } catch {
    throw new BinanceReceiverUnavailableError()
  }

  if (bytes.length < 16 || bytes.length > QR_MAX_BYTES || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') {
    throw new BinanceReceiverUnavailableError()
  }

  const actual = Buffer.from(createHash('sha256').update(bytes).digest('hex'), 'hex')
  const expected = Buffer.from(settings.expectedHash, 'hex')
  if (!timingSafeEqual(actual, expected)) {
    throw new BinanceReceiverUnavailableError()
  }

  return { uid: settings.uid, name: settings.name, qrBytes: bytes, qrContentType: 'image/webp', verifiedAt: Date.now() }
}

export async function getVerifiedBinanceReceiver() {
  const settings = readReceiverSettings()
  if (cache?.key === settings.cacheKey && Date.now() - cache.value.verifiedAt < QR_CACHE_MS) {
    return cache.value
  }

  if (pending?.key === settings.cacheKey) return pending.promise

  const promise = verifyReceiverQr(settings)
  pending = { key: settings.cacheKey, promise }
  try {
    const value = await promise
    cache = { key: settings.cacheKey, value }
    return value
  } finally {
    if (pending?.promise === promise) pending = null
  }
}
