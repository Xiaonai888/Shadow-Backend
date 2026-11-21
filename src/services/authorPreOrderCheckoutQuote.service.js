import { preOrderError } from './authorPreOrderValidation.service.js'
import {
  parseAuthorPreOrderQuoteInput,
  preOrderMoneyCents,
  preOrderDollars,
} from './authorPreOrderReaderValidation.service.js'
import { getPublicAuthorPreOrder } from './authorPreOrderPublicCatalog.service.js'

export async function quoteAuthorPreOrder(campaignId, rawInput) {
  const input = parseAuthorPreOrderQuoteInput(rawInput)
  const record = await getPublicAuthorPreOrder(campaignId)
  const now = Date.now()
  const opens = Date.parse(String(record.open_at || ''))
  const closes = Date.parse(String(record.close_at || ''))
  if (record.status !== 'active' || !Number.isFinite(opens) || !Number.isFinite(closes) || now < opens || now >= closes) {
    throw preOrderError('PRE_ORDER_READER_NOT_OPEN', 'Pre-order is not open for checkout', 409)
  }
  const edition = record.book.editions[input.edition]
  if (!edition || !edition.enabled) {
    throw preOrderError('PRE_ORDER_READER_EDITION_UNAVAILABLE', 'This edition is not available', 409)
  }
  if (!Number.isSafeInteger(edition.available) || edition.available < input.quantity) {
    throw preOrderError('PRE_ORDER_READER_SOLD_OUT', 'Not enough copies remain for this edition', 409)
  }
  const carrier = record.delivery_companies.find(company => company.company_key === input.deliveryKey)
  if (!carrier) {
    throw preOrderError('PRE_ORDER_READER_DELIVERY_UNAVAILABLE', 'Selected delivery company is not available', 409)
  }
  if (input.signed && !record.signature_enabled) {
    throw preOrderError('PRE_ORDER_READER_SIGNATURE_UNAVAILABLE', 'Signed copies are not available', 409)
  }
  const unitCents = preOrderMoneyCents(edition.price_usd, 'edition price')
  const signatureCents = input.signed ? preOrderMoneyCents(record.signature_fee_usd, 'signature fee') : 0
  const deliveryCents = preOrderMoneyCents(carrier.fee_usd, 'delivery fee')
  if (unitCents < 1) {
    throw preOrderError('PRE_ORDER_READER_PRICE_UNAVAILABLE', 'Edition price is invalid', 503)
  }
  const subtotalCents = unitCents * input.quantity
  const totalCents = subtotalCents + signatureCents + deliveryCents
  return {
    campaign_id: record.id,
    book_id: record.book.id,
    book_title: record.book.title,
    edition: input.edition,
    quantity: input.quantity,
    available_at_quote: edition.available,
    signature_requested: input.signed,
    delivery_company: carrier,
    unit_price_usd: preOrderDollars(unitCents),
    subtotal_usd: preOrderDollars(subtotalCents),
    signature_fee_usd: preOrderDollars(signatureCents),
    delivery_fee_usd: preOrderDollars(deliveryCents),
    total_usd: preOrderDollars(totalCents),
    currency: 'USD',
    quote_only: true,
    inventory_reserved: false,
    payment_created: false,
    quoted_at: new Date(now).toISOString(),
  }
}
