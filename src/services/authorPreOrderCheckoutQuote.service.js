import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'
import {
  parseAuthorPreOrderQuoteInput,
  preOrderMoneyCents,
  preOrderDollars,
} from './authorPreOrderReaderValidation.service.js'
import { parseAuthorPreOrderVolumeSelection } from './authorPreOrderVolumeSelection.service.js'
import { getPublicAuthorPreOrder } from './authorPreOrderPublicCatalog.service.js'

function normalizeCheckoutSelection(rawInput, record, parsed) {
  if (rawInput?.items !== undefined) {
    const selection = parsed
    return {
      items: selection.items,
      deliveryKey: selection.delivery_company_key,
      signed: selection.signature_requested,
    }
  }

  const legacy = parsed
  const selectedBookId = rawInput?.book_id === undefined
    ? record.book?.id
    : preOrderUuid(rawInput.book_id, 'selected volume ID')
  if (!selectedBookId) {
    throw preOrderError('PRE_ORDER_READER_VOLUME_MISSING', 'No volume is available for checkout', 503)
  }
  return {
    items: [{
      book_id: String(selectedBookId).toLowerCase(),
      edition: legacy.edition,
      quantity: legacy.quantity,
    }],
    deliveryKey: legacy.deliveryKey,
    signed: legacy.signed,
  }
}

function safeCents(value, field) {
  const cents = preOrderMoneyCents(value, field)
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw preOrderError('PRE_ORDER_READER_PRICE_UNAVAILABLE', `Invalid ${field}`, 503)
  }
  return cents
}

export async function quoteAuthorPreOrder(campaignId, rawInput) {
  const parsed = rawInput?.items !== undefined
    ? parseAuthorPreOrderVolumeSelection(rawInput)
    : parseAuthorPreOrderQuoteInput(rawInput)
  const record = await getPublicAuthorPreOrder(campaignId)
  const now = Date.now()
  const opens = Date.parse(String(record?.open_at || ''))
  const closes = Date.parse(String(record?.close_at || ''))
  if (record?.status !== 'active' || !Number.isFinite(opens) ||
      !Number.isFinite(closes) || now < opens || now >= closes) {
    throw preOrderError('PRE_ORDER_READER_NOT_OPEN', 'Pre-order is not open for checkout', 409)
  }

  const selection = normalizeCheckoutSelection(rawInput, record, parsed)
  const books = Array.isArray(record.books) ? record.books : record.book ? [record.book] : []
  if (books.length < 1 || books.length > 10) {
    throw preOrderError('PRE_ORDER_READER_VOLUMES_INVALID', 'Pre-order volume list is invalid', 503)
  }
  const bookById = new Map(books.map(book => [String(book?.id || '').toLowerCase(), book]))
  if (bookById.size !== books.length) {
    throw preOrderError('PRE_ORDER_READER_VOLUMES_INVALID', 'Duplicate or missing pre-order volumes', 503)
  }

  let subtotalCents = 0
  let totalQuantity = 0
  const items = selection.items.map(line => {
    const book = bookById.get(line.book_id)
    if (!book) {
      throw preOrderError('PRE_ORDER_READER_VOLUME_UNAVAILABLE', 'Selected volume is not part of this pre-order', 409)
    }
    const edition = book.editions?.[line.edition]
    if (!edition?.enabled) {
      throw preOrderError('PRE_ORDER_READER_EDITION_UNAVAILABLE', 'This edition is not available', 409)
    }
    const available = Number(edition.available)
    if (!Number.isSafeInteger(available) || available < 0 || available < line.quantity) {
      throw preOrderError('PRE_ORDER_READER_SOLD_OUT', 'Not enough copies remain for this edition', 409)
    }
    const unitCents = safeCents(edition.price_usd, 'edition price')
    const lineTotal = unitCents * line.quantity
    if (unitCents < 1 || !Number.isSafeInteger(lineTotal)) {
      throw preOrderError('PRE_ORDER_READER_PRICE_UNAVAILABLE', 'Invalid pre-order book price', 503)
    }
    subtotalCents += lineTotal
    totalQuantity += line.quantity
    if (!Number.isSafeInteger(subtotalCents) || !Number.isSafeInteger(totalQuantity)) {
      throw preOrderError('PRE_ORDER_READER_PRICE_UNAVAILABLE', 'Pre-order total exceeds the supported amount', 503)
    }
    return {
      book_id: book.id,
      book_title: String(book.title || ''),
      cover_url: String(book.cover_url || ''),
      edition: line.edition,
      quantity: line.quantity,
      available_at_quote: available,
      unit_price_usd: preOrderDollars(unitCents),
      line_total_usd: preOrderDollars(lineTotal),
    }
  })

  const carrier = Array.isArray(record.delivery_companies)
    ? record.delivery_companies.find(company => company.company_key === selection.deliveryKey)
    : null
  if (!carrier) {
    throw preOrderError('PRE_ORDER_READER_DELIVERY_UNAVAILABLE', 'Selected delivery company is not available', 409)
  }
  if (selection.signed && record.signature_enabled !== true) {
    throw preOrderError('PRE_ORDER_READER_SIGNATURE_UNAVAILABLE', 'Signed copies are not available', 409)
  }
  const signatureCents = selection.signed ? safeCents(record.signature_fee_usd, 'signature fee') : 0
  const deliveryCents = safeCents(carrier.fee_usd, 'delivery fee')
  const totalCents = subtotalCents + signatureCents + deliveryCents
  if (!Number.isSafeInteger(totalCents) || totalCents < 1) {
    throw preOrderError('PRE_ORDER_READER_PRICE_UNAVAILABLE', 'Pre-order total is invalid', 503)
  }

  const single = items.length === 1 ? items[0] : null
  return {
    campaign_id: record.id,
    campaign_title: record.title,
    items,
    item_count: items.length,
    total_quantity: totalQuantity,
    ...(single ? {
      book_id: single.book_id,
      book_title: single.book_title,
      edition: single.edition,
      quantity: single.quantity,
      available_at_quote: single.available_at_quote,
      unit_price_usd: single.unit_price_usd,
    } : {}),
    signature_requested: selection.signed,
    delivery_company: carrier,
    subtotal_usd: preOrderDollars(subtotalCents),
    signature_fee_usd: preOrderDollars(signatureCents),
    delivery_fee_usd: preOrderDollars(deliveryCents),
    total_usd: preOrderDollars(totalCents),
    currency: 'USD',
    stock_snapshot_complete: record.stock_snapshot_complete === true,
    quote_only: true,
    order_created: false,
    inventory_reserved: false,
    payment_created: false,
    payment_enabled: false,
    quoted_at: new Date(now).toISOString(),
  }
}
