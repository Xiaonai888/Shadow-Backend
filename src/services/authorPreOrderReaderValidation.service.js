import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'

const EDITIONS = new Set(['standard', 'limited'])
const CARRIER_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedInteger(value, min, max, field) {
  let number
  if (typeof value === 'number') {
    number = value
  } else if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) {
    number = Number(value.trim())
  } else {
    throw preOrderError('PRE_ORDER_READER_INVALID_INPUT', `Invalid ${field}`, 400)
  }
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw preOrderError('PRE_ORDER_READER_INVALID_INPUT', `Invalid ${field}`, 400)
  }
  return number
}

export function parsePublicPreOrderListQuery(query = {}) {
  if (!plainObject(query)) {
    throw preOrderError('PRE_ORDER_READER_INVALID_FILTER', 'Invalid list filters', 400)
  }
  const page = boundedInteger(query.page ?? 1, 1, 10000, 'page')
  const limit = boundedInteger(query.limit ?? 12, 1, 24, 'limit')
  if (query.status !== undefined && typeof query.status !== 'string') {
    throw preOrderError('PRE_ORDER_READER_INVALID_FILTER', 'Invalid publication status', 400)
  }
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
  const edition = typeof input.edition === 'string' ? input.edition.trim().toLowerCase() : ''
  if (!EDITIONS.has(edition)) {
    throw preOrderError('PRE_ORDER_READER_INVALID_EDITION', 'Choose Standard or Limited edition', 400)
  }
  const quantity = boundedInteger(input.quantity, 1, 99, 'quantity')
  const delivery = input.delivery_company_key ?? input.deliveryKey ?? ''
  const deliveryKey = typeof delivery === 'string' ? delivery.trim().toLowerCase() : ''
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
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw preOrderError('PRE_ORDER_READER_PRICE_UNAVAILABLE', `Invalid server ${field}`, 503)
  }
  const stringValue = String(value)
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(stringValue)) {
    throw preOrderError('PRE_ORDER_READER_PRICE_UNAVAILABLE', `Invalid server ${field}`, 503)
  }
  const [dollars, fraction = ''] = stringValue.split('.')
  const cents = Number(dollars) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw preOrderError('PRE_ORDER_READER_PRICE_UNAVAILABLE', `Invalid server ${field}`, 503)
  }
  return cents
}

export function preOrderDollars(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw preOrderError('PRE_ORDER_READER_PRICE_UNAVAILABLE', 'Quote amount overflow', 503)
  }
  return Number((cents / 100).toFixed(2))
}

export { preOrderUuid }
