import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'
import { parseAuthorPreOrderQuoteInput } from './authorPreOrderReaderValidation.service.js'
import { parseAuthorPreOrderVolumeSelection } from './authorPreOrderVolumeSelection.service.js'
import { getPublicAuthorPreOrder } from './authorPreOrderPublicCatalog.service.js'
import { getAuthorPreOrderPaymentAvailability } from './authorPreOrderPaymentAvailability.service.js'
import { startReaderMultiVolumePreOrderCheckout } from './authorPreOrderMultiVolumeCheckoutStart.service.js'

function requirePaymentReady() {
  const available = getAuthorPreOrderPaymentAvailability()
  if (available?.payment_enabled !== true || available?.can_create_order !== true ||
      available?.can_start_payment !== true || available?.can_confirm_payment !== true ||
      available?.inventory_reservation_enabled !== true) {
    throw preOrderError('PRE_ORDER_PAYMENT_NOT_READY', 'Pre-order payment is not available yet', 503)
  }
}

async function normalizeSelection(campaignId, input) {
  if (input.items !== undefined) {
    if (input.book_id !== undefined || input.edition !== undefined || input.quantity !== undefined) {
      throw preOrderError('PRE_ORDER_CHECKOUT_SELECTION_CONFLICT', 'Use either volume items or a single-volume selection', 400)
    }
    return parseAuthorPreOrderVolumeSelection(input)
  }

  const legacy = parseAuthorPreOrderQuoteInput(input)
  let bookId
  if (input.book_id !== undefined) {
    bookId = preOrderUuid(input.book_id, 'selected volume ID').toLowerCase()
  } else {
    const record = await getPublicAuthorPreOrder(campaignId, { includeDelivery: false })
    const books = Array.isArray(record?.books) ? record.books : record?.book ? [record.book] : []
    if (books.length !== 1) {
      throw preOrderError('PRE_ORDER_VOLUME_SELECTION_REQUIRED', 'Choose a volume before starting payment', 409)
    }
    bookId = preOrderUuid(books[0].id, 'selected volume ID').toLowerCase()
  }
  return parseAuthorPreOrderVolumeSelection({
    items: [{ book_id: bookId, edition: legacy.edition, quantity: legacy.quantity }],
    delivery_company_key: legacy.deliveryKey,
    signature_requested: legacy.signed,
  })
}

export async function startReaderAuthorPreOrderCheckout(campaignId, buyerUserId, input, { signal } = {}) {
  requirePaymentReady()
  if (signal?.aborted) {
    throw preOrderError('PRE_ORDER_CHECKOUT_ABORTED', 'Checkout request was cancelled', 503)
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw preOrderError('PRE_ORDER_CHECKOUT_INPUT_INVALID', 'Checkout options are required', 400)
  }
  const campaign = preOrderUuid(campaignId, 'pre-order ID').toLowerCase()
  const buyer = preOrderUuid(buyerUserId, 'buyer account ID').toLowerCase()
  const requestKey = preOrderUuid(input.request_key, 'checkout request key').toLowerCase()
  const selection = await normalizeSelection(campaign, input)
  return startReaderMultiVolumePreOrderCheckout(campaign, buyer, {
    ...input,
    request_key: requestKey,
    items: selection.items,
    delivery_company_key: selection.delivery_company_key,
    signature_requested: selection.signature_requested,
  }, { signal })
}
