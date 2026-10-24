import { createHmac } from 'node:crypto'

const BINANCE_PAY_HISTORY_URL = 'https://api.binance.com/sapi/v1/pay/transactions'
const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000
const DEFAULT_WINDOW_MS = 15 * 60 * 1000
const MAX_PAGE_SIZE = 100

function requireCredentials() {
  const apiKey = String(process.env.BINANCE_USDT_API_KEY || '').trim()
  const secret = String(process.env.BINANCE_USDT_API_SECRET || '').trim()

  if (!apiKey || !secret) {
    throw new Error('Binance USDT API credentials are not configured')
  }

  return { apiKey, secret }
}

function readWindow(startTime, endTime) {
  const now = Date.now()
  const end = endTime === undefined ? now : Number(endTime)
  const start = startTime === undefined ? end - DEFAULT_WINDOW_MS : Number(startTime)

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end - start > MAX_WINDOW_MS ||
    end > now + 60_000
  ) {
    throw new RangeError('Invalid Binance Pay history time window')
  }

  return { start, end }
}

function readLimit(value) {
  const limit = Number(value)
  if (!Number.isSafeInteger(limit)) return MAX_PAGE_SIZE
  return Math.max(1, Math.min(MAX_PAGE_SIZE, limit))
}

export function normalizeBinanceUsdtIncome(transaction) {
  if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) {
    return null
  }

  if (String(transaction.currency || '').toUpperCase() !== 'USDT') return null

  const amount = String(transaction.amount ?? '').trim()
  if (!/^(?:0|[1-9]\d{0,18})(?:\.\d{1,8})?$/.test(amount)) return null
  if (Number(amount) <= 0) return null

  const transactionId = String(transaction.transactionId || '').trim()
  const transactionTime = Number(transaction.transactionTime)
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(transactionId)) return null
  if (!Number.isSafeInteger(transactionTime) || transactionTime <= 0) return null

  const payerName = String(transaction.payerInfo?.name || '').trim().slice(0, 120)
  const orderType = String(transaction.orderType || '').trim().slice(0, 40)

  return {
    transactionId,
    transactionTime,
    amount,
    currency: 'USDT',
    orderType,
    payerName,
  }
}

export async function fetchBinanceUsdtIncome({ startTime, endTime, limit = 100 } = {}) {
  const { apiKey, secret } = requireCredentials()
  const { start, end } = readWindow(startTime, endTime)
  const pageSize = readLimit(limit)

  const params = new URLSearchParams({
    startTime: String(start),
    endTime: String(end),
    limit: String(pageSize),
    recvWindow: '5000',
    timestamp: String(Date.now()),
  })

  const signature = createHmac('sha256', secret).update(params.toString()).digest('hex')
  params.set('signature', signature)

  const response = await fetch(`${BINANCE_PAY_HISTORY_URL}?${params.toString()}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-MBX-APIKEY': apiKey,
    },
    redirect: 'error',
    signal: AbortSignal.timeout(12_000),
  })

  if (!response.ok) {
    throw new Error(`Binance Pay history returned HTTP ${response.status}`)
  }

  const result = await response.json()
  if (
    !result ||
    result.success !== true ||
    result.code !== '000000' ||
    !Array.isArray(result.data) ||
    result.data.length > pageSize
  ) {
    throw new Error('Unexpected Binance Pay history response')
  }

  const receipts = result.data
    .map(normalizeBinanceUsdtIncome)
    .filter((item) => item && item.transactionTime >= start && item.transactionTime <= end)
    .sort((a, b) => a.transactionTime - b.transactionTime || a.transactionId.localeCompare(b.transactionId))

  return {
    startTime: start,
    endTime: end,
    fetchedCount: result.data.length,
    possibleMore: result.data.length === pageSize,
    receipts,
  }
}
