import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'

const EDITIONS = new Set(['standard', 'limited'])
const CARRIER_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedInteger(value, min, max, field) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw preOrderError('PRE_ORDER_READER_INVALID_INPUT', `Invalid ${field}`, 400)
  }
  return number
}

export function parsePublicPreOrderListQuery(query = {}) {
  const page = boundedInteger(query.page ?? 1, 1, 10000, 'page')
  const limit = boundedInteger(query.limit ?? 12, 1, 24, 'limit')
  const status = String(query.status ?? 'all').trim().toLowerCase()
  if (!['all', 'active', 'scheduled'].includes(status)) {
    throw preOrderError('PRE_ORDER_READER_INVALID_FILTER', 'Invalid publication status', 400)
  }
  if (typeof query.search !== 'undefined' && typeof query.search !== 'string') {
    throw preOrderError('PRE_ORDER_READER_INVALID_FILTER', 'Invalid search', 400)
  }
  const search = String(query.search || '').trim()
  if (search.length > 100) {
    throw preOrderError('PRE_ORDER_READER_INVALID_FILTER', 'Search is too long', 400)
  }
  return { page, limit, status, search }
}

export function parseAuthorPreOrderQuoteInput(input) {
  if (!plainObject(input)) {
    throw preOrderError('PRE_ORDER_READER_INVALID_INPUT', 'Quote options must be an object', 400)
  }
  const edition = String(input.edition || '').trim().toLowerCase()
  if (!EDITIONS.has(edition)) {
    throw preOrderError('PRE_ORDER_READER_INVALID_EDITION', 'Choose Standard or Limited edition', 400)
  }
  const quantity = boundedInteger(input.quantity, 1, 99, 'quantity')
  const deliveryKey = String(input.delivery_company_key ?? input.deliveryKey ?? '').trim().toLowerCase()
  if (!CARRIER_KEY.test(deliveryKey)) {
    throw preOrderError('PRE_ORDER_READER_INVALID_DELIVERY', 'Choose a valid delivery company', 400)
  }
  const signed = input.signature_requested ?? input.signatureRequested ?? false
  if (typeof signed !== 'boolean') {
    throw preOrderError('PRE_ORDER_READER_INVALID_SIGNATURE', 'Invalid signature selection', 400)
  }
  return { edition, quantity, deliveryKey, signed }
}

export function preOrderMoneyCents(value, field) {
  const stringValue = String(value ?? '')
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(stringValue)) {
    throw preOrderError('PRE_ORDER_READER_PRICE_UNAVAILABLE', `Invalid server ${field}`, 503)
  }
  const amount = Number(stringValue)
  if (!Number.isSafeInteger(Math.round(amount * 100)) || amount < 0) {
    throw preOrderError('PRE_ORDER_READER_PRICE_UNAVAILABLE', `Invalid server ${field}`, 503)
  }
  return Math.round(amount * 100)
}

export function preOrderDollars(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw preOrderError('PRE_ORDER_READER_PRICE_UNAVAILABLE', 'Quote amount overflow', 503)
  }
  return Number((cents / 100).toFixed(2))
}

export { preOrderUuid }
