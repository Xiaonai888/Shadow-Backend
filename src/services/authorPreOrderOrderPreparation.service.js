import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'
import { parseAuthorPreOrderQuoteInput } from './authorPreOrderReaderValidation.service.js'
import { quoteAuthorPreOrder } from './authorPreOrderCheckoutQuote.service.js'
import { parseAuthorPreOrderBuyerInput } from './authorPreOrderBuyerInput.service.js'

export async function prepareAuthorPreOrderReview(campaignId, buyerUserId, rawInput) {
  const recordId = preOrderUuid(campaignId, 'pre-order ID')
  preOrderUuid(buyerUserId, 'buyer account ID')
  const options = parseAuthorPreOrderQuoteInput(rawInput)
  const information = parseAuthorPreOrderBuyerInput(rawInput, {
    signatureRequested: options.signed,
  })

  const quote = await quoteAuthorPreOrder(recordId, {
    edition: options.edition,
    quantity: options.quantity,
    delivery_company_key: options.deliveryKey,
    signature_requested: options.signed,
  })

  if (!quote || quote.quote_only !== true || quote.inventory_reserved !== false ||
      quote.payment_created !== false || quote.campaign_id !== recordId ||
      quote.edition !== options.edition || quote.quantity !== options.quantity ||
      quote.delivery_company?.company_key !== options.deliveryKey ||
      quote.signature_requested !== options.signed || quote.currency !== 'USD') {
    throw preOrderError('PRE_ORDER_PREPARATION_INVALID_QUOTE', 'Price preview could not be verified', 503)
  }

  const carrier = quote.delivery_company
  const buyer = information.buyer

  return {
    campaign_id: quote.campaign_id,
    book_id: quote.book_id,
    book_title: quote.book_title,
    items: [{
      book_id: quote.book_id,
      edition: quote.edition,
      quantity: quote.quantity,
      unit_price_usd: quote.unit_price_usd,
      line_total_usd: quote.subtotal_usd,
    }],
    buyer_snapshot: buyer,
    delivery_snapshot: {
      address: buyer.delivery_address,
      province_city: buyer.province_city,
      company: {
        company_key: carrier.company_key,
        company_name: carrier.company_name,
        fee_usd: carrier.fee_usd,
        logo_url: carrier.logo_url || '',
      },
    },
    signature_requested: options.signed,
    signature_name: information.signature_name,
    buyer_note: information.buyer_note,
    pricing: {
      subtotal_usd: quote.subtotal_usd,
      signature_fee_usd: quote.signature_fee_usd,
      delivery_fee_usd: quote.delivery_fee_usd,
      total_usd: quote.total_usd,
      currency: quote.currency,
    },
    available_at_quote: quote.available_at_quote,
    quoted_at: quote.quoted_at,
    preview_only: true,
    order_created: false,
    inventory_reserved: false,
    payment_created: false,
    payment_enabled: false,
  }
}
