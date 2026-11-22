import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'
import {
  parseAuthorPreOrderQuoteInput,
  preOrderMoneyCents,
} from './authorPreOrderReaderValidation.service.js'
import { parseAuthorPreOrderVolumeSelection } from './authorPreOrderVolumeSelection.service.js'
import { quoteAuthorPreOrder } from './authorPreOrderCheckoutQuote.service.js'
import { parseAuthorPreOrderBuyerInput } from './authorPreOrderBuyerInput.service.js'

function invalidReview() {
  throw preOrderError('PRE_ORDER_PREPARATION_INVALID_QUOTE', 'Price preview could not be verified', 503)
}

function verifiedAmount(value, field) {
  return preOrderMoneyCents(value, field)
}

function verifyItems(quote, selectedItems, { legacyEdition = null, legacyQuantity = null, legacyBookId = null } = {}) {
  if (!Array.isArray(quote?.items) || quote.items.length < 1 || quote.items.length > 10 ||
      quote.items.length !== selectedItems?.length && legacyEdition === null) {
    invalidReview()
  }

  const selection = selectedItems
    ? new Map(selectedItems.map(item => [item.book_id, item]))
    : null
  const seen = new Set()
  let subtotalCents = 0
  let totalQuantity = 0
  const items = quote.items.map(line => {
    let bookId
    try {
      bookId = preOrderUuid(line?.book_id, 'quoted volume ID').toLowerCase()
    } catch {
      invalidReview()
    }
    if (seen.has(bookId)) invalidReview()
    seen.add(bookId)
    const quantity = Number(line?.quantity)
    const available = Number(line?.available_at_quote)
    const edition = String(line?.edition || '')
    const expected = selection?.get(bookId)
    if (!['standard', 'limited'].includes(edition) ||
        !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99 ||
        !Number.isSafeInteger(available) || available < quantity ||
        (selection && (!expected || expected.edition !== edition || expected.quantity !== quantity)) ||
        (!selection && (quote.items.length !== 1 || edition !== legacyEdition ||
          quantity !== legacyQuantity || (legacyBookId && bookId !== legacyBookId)))) {
      invalidReview()
    }
    const unitCents = verifiedAmount(line.unit_price_usd, 'volume unit price')
    const lineCents = verifiedAmount(line.line_total_usd, 'volume line total')
    if (unitCents < 1 || !Number.isSafeInteger(unitCents * quantity) ||
        lineCents !== unitCents * quantity) {
      invalidReview()
    }
    subtotalCents += lineCents
    totalQuantity += quantity
    if (!Number.isSafeInteger(subtotalCents) || !Number.isSafeInteger(totalQuantity)) {
      invalidReview()
    }
    return {
      book_id: bookId,
      book_title: String(line.book_title || ''),
      cover_url: String(line.cover_url || ''),
      edition,
      quantity,
      unit_price_usd: unitCents / 100,
      line_total_usd: lineCents / 100,
      available_at_quote: available,
    }
  })
  if ((selection && seen.size !== selection.size) ||
      verifiedAmount(quote.subtotal_usd, 'quoted subtotal') !== subtotalCents ||
      Number(quote.item_count) !== items.length || Number(quote.total_quantity) !== totalQuantity) {
    invalidReview()
  }
  return { items, subtotalCents, totalQuantity }
}

export async function prepareAuthorPreOrderReview(campaignId, buyerUserId, rawInput) {
  const recordId = preOrderUuid(campaignId, 'pre-order ID').toLowerCase()
  preOrderUuid(buyerUserId, 'buyer account ID')
  const isMultiVolume = rawInput?.items !== undefined
  const options = isMultiVolume
    ? parseAuthorPreOrderVolumeSelection(rawInput)
    : parseAuthorPreOrderQuoteInput(rawInput)
  const signed = isMultiVolume ? options.signature_requested : options.signed
  const deliveryKey = isMultiVolume ? options.delivery_company_key : options.deliveryKey
  const information = parseAuthorPreOrderBuyerInput(rawInput, { signatureRequested: signed })
  const quoteInput = isMultiVolume
    ? {
        items: options.items,
        delivery_company_key: deliveryKey,
        signature_requested: signed,
      }
    : {
        edition: options.edition,
        quantity: options.quantity,
        delivery_company_key: deliveryKey,
        signature_requested: signed,
        ...(rawInput?.book_id !== undefined
          ? { book_id: preOrderUuid(rawInput.book_id, 'selected volume ID').toLowerCase() }
          : {}),
      }

  const quote = await quoteAuthorPreOrder(recordId, quoteInput)
  if (!quote || quote.quote_only !== true || quote.order_created !== false ||
      quote.inventory_reserved !== false || quote.payment_created !== false ||
      quote.payment_enabled !== false ||
      String(quote.campaign_id || '').toLowerCase() !== recordId ||
      quote.delivery_company?.company_key !== deliveryKey ||
      quote.signature_requested !== signed || quote.currency !== 'USD') {
    invalidReview()
  }

  const reviewItems = verifyItems(quote, isMultiVolume ? options.items : null, {
    legacyEdition: isMultiVolume ? null : options.edition,
    legacyQuantity: isMultiVolume ? null : options.quantity,
    legacyBookId: !isMultiVolume && quoteInput.book_id ? quoteInput.book_id : null,
  })
  const signatureCents = verifiedAmount(quote.signature_fee_usd, 'signature fee')
  const deliveryCents = verifiedAmount(quote.delivery_fee_usd, 'delivery fee')
  const totalCents = verifiedAmount(quote.total_usd, 'quoted total')
  if ((!signed && signatureCents !== 0) ||
      !Number.isSafeInteger(reviewItems.subtotalCents + signatureCents + deliveryCents) ||
      totalCents !== reviewItems.subtotalCents + signatureCents + deliveryCents || totalCents < 1 ||
      verifiedAmount(quote.delivery_company?.fee_usd, 'delivery company fee') !== deliveryCents) {
    invalidReview()
  }

  const carrier = quote.delivery_company
  const buyer = information.buyer
  const single = reviewItems.items.length === 1 ? reviewItems.items[0] : null
  return {
    campaign_id: recordId,
    ...(single ? {
      book_id: single.book_id,
      book_title: single.book_title,
      available_at_quote: single.available_at_quote,
    } : {}),
    items: reviewItems.items,
    item_count: reviewItems.items.length,
    total_quantity: reviewItems.totalQuantity,
    buyer_snapshot: buyer,
    delivery_snapshot: {
      address: buyer.delivery_address,
      province_city: buyer.province_city,
      company: {
        company_key: carrier.company_key,
        company_name: carrier.company_name,
        fee_usd: deliveryCents / 100,
        logo_url: carrier.logo_url || '',
      },
    },
    signature_requested: signed,
    signature_name: information.signature_name,
    buyer_note: information.buyer_note,
    pricing: {
      subtotal_usd: reviewItems.subtotalCents / 100,
      signature_fee_usd: signatureCents / 100,
      delivery_fee_usd: deliveryCents / 100,
      total_usd: totalCents / 100,
      currency: 'USD',
    },
    stock_snapshot_complete: quote.stock_snapshot_complete === true,
    quoted_at: quote.quoted_at,
    preview_only: true,
    order_created: false,
    inventory_reserved: false,
    payment_created: false,
    payment_enabled: false,
  }
}
