import { preOrderError } from './authorPreOrderValidation.service.js'
import { preOrderMoneyCents, preOrderDollars } from './authorPreOrderReaderValidation.service.js'
import { parseAuthorPreOrderVolumeSelection } from './authorPreOrderVolumeSelection.service.js'
import { getPublicAuthorPreOrderVolumeCatalog } from './authorPreOrderVolumeCatalog.service.js'

export async function quoteAuthorPreOrderVolumes(campaignId, rawInput) {
  const input = parseAuthorPreOrderVolumeSelection(rawInput)
  const record = await getPublicAuthorPreOrderVolumeCatalog(campaignId)
  const now = Date.now()
  const openAt = Date.parse(String(record.open_at || ''))
  const closeAt = Date.parse(String(record.close_at || ''))
  if (record.status !== 'active' || !Number.isFinite(openAt) ||
      !Number.isFinite(closeAt) || now < openAt || now >= closeAt) {
    throw preOrderError('PRE_ORDER_VOLUME_NOT_OPEN', 'Pre-order is not open for checkout', 409)
  }

  const books = new Map(record.books.map(book => [book.id.toLowerCase(), book]))
  let subtotalCents = 0
  let totalQuantity = 0
  const items = input.items.map(line => {
    const book = books.get(line.book_id)
    const edition = book?.editions?.[line.edition]
    if (!book || !edition?.enabled || !Number.isSafeInteger(edition.available) ||
        line.quantity > edition.available) {
      throw preOrderError('PRE_ORDER_VOLUME_UNAVAILABLE', 'A selected volume or edition is unavailable', 409)
    }
    const unitCents = preOrderMoneyCents(edition.price_usd, 'volume price')
    if (unitCents < 1) {
      throw preOrderError('PRE_ORDER_VOLUME_PRICE_INVALID', 'A selected volume has no valid price', 503)
    }
    const lineCents = unitCents * line.quantity
    subtotalCents += lineCents
    totalQuantity += line.quantity
    if (!Number.isSafeInteger(subtotalCents) || !Number.isSafeInteger(totalQuantity)) {
      throw preOrderError('PRE_ORDER_VOLUME_AMOUNT_OVERFLOW', 'Checkout amount is too large', 503)
    }
    return {
      book_id: book.id,
      book_title: book.title,
      cover_url: book.cover_url,
      edition: line.edition,
      quantity: line.quantity,
      available_at_quote: edition.available,
      unit_price_usd: preOrderDollars(unitCents),
      line_total_usd: preOrderDollars(lineCents),
    }
  })

  const company = record.delivery_companies.find(item => item.company_key === input.delivery_company_key)
  if (!company) {
    throw preOrderError('PRE_ORDER_VOLUME_DELIVERY_UNAVAILABLE', 'Selected delivery company is not available', 409)
  }
  if (input.signature_requested && !record.signature_enabled) {
    throw preOrderError('PRE_ORDER_VOLUME_SIGNATURE_UNAVAILABLE', 'Signed copies are not available', 409)
  }
  const signatureCents = input.signature_requested ? preOrderMoneyCents(record.signature_fee_usd, 'signature fee') : 0
  const deliveryCents = preOrderMoneyCents(company.fee_usd, 'delivery fee')
  const totalCents = subtotalCents + signatureCents + deliveryCents
  if (!Number.isSafeInteger(totalCents) || totalCents < 1) {
    throw preOrderError('PRE_ORDER_VOLUME_TOTAL_INVALID', 'Checkout total is invalid', 503)
  }

  return {
    campaign_id: record.id,
    campaign_title: record.title,
    items,
    total_quantity: totalQuantity,
    delivery_company: company,
    signature_requested: input.signature_requested,
    subtotal_usd: preOrderDollars(subtotalCents),
    signature_fee_usd: preOrderDollars(signatureCents),
    delivery_fee_usd: preOrderDollars(deliveryCents),
    total_usd: preOrderDollars(totalCents),
    currency: 'USD',
    quote_only: true,
    inventory_reserved: false,
    order_created: false,
    payment_created: false,
    payment_enabled: false,
    quoted_at: new Date(now).toISOString(),
  }
}
