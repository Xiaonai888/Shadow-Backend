import { randomBytes } from 'node:crypto'
import { preOrderError } from './authorPreOrderValidation.service.js'

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const TRANSACTION = /^P[A-Z0-9]{12,39}$/
const USD = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/

export function preOrderPaymentId(value, field = 'order ID') {
  const id = String(value ?? '').trim()
  if (!UUID.test(id)) throw preOrderError('PRE_ORDER_PAYMENT_INVALID_ID', `Invalid ${field}`, 400)
  return id.toLowerCase()
}

export function preOrderPaymentTransaction(value) {
  const transaction = String(value ?? '').trim()
  if (!TRANSACTION.test(transaction)) {
    throw preOrderError('PRE_ORDER_PAYMENT_INVALID_TRANSACTION', 'Invalid PayWay merchant transaction', 400)
  }
  return transaction
}

export function createPreOrderPaymentTransaction() {
  return preOrderPaymentTransaction(`P${Date.now().toString(36).toUpperCase()}${randomBytes(12).toString('hex').toUpperCase()}`)
}

export function preOrderPaymentCents(value, field = 'amount') {
  const amount = String(value ?? '').trim()
  if (!USD.test(amount)) {
    throw preOrderError('PRE_ORDER_PAYMENT_AMOUNT_INVALID', `Invalid ${field}`, 503)
  }
  const [dollars, fractional = ''] = amount.split('.')
  const cents = Number(dollars) * 100 + Number(fractional.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw preOrderError('PRE_ORDER_PAYMENT_AMOUNT_INVALID', `Invalid ${field}`, 503)
  }
  return cents
}

export function preOrderPaymentCurrency(value) {
  if (value !== 'USD') {
    throw preOrderError('PRE_ORDER_PAYMENT_CURRENCY_INVALID', 'Pre-order payments must use USD', 503)
  }
  return 'USD'
}

export function preOrderProviderPaidAt(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null
  const time = Date.parse(value)
  if (!Number.isFinite(time) || time > Date.now() + 10 * 60 * 1000) return null
  return new Date(time).toISOString()
}
