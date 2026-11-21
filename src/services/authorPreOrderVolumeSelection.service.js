import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'

const EDITIONS = new Set(['standard', 'limited'])
const DELIVERY_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseAuthorPreOrderVolumeSelection(input) {
  if (!isRecord(input) || !Array.isArray(input.items) ||
      input.items.length < 1 || input.items.length > 10) {
    throw preOrderError('PRE_ORDER_VOLUME_ITEMS_INVALID', 'Choose between 1 and 10 volumes', 400)
  }

  const seen = new Set()
  const items = input.items.map((raw, index) => {
    if (!isRecord(raw)) {
      throw preOrderError('PRE_ORDER_VOLUME_ITEM_INVALID', `Invalid volume ${index + 1}`, 400)
    }
    const bookId = preOrderUuid(raw.book_id, 'volume ID').toLowerCase()
    const edition = String(raw.edition || '').trim().toLowerCase()
    const quantity = Number(raw.quantity)
    if (!EDITIONS.has(edition) || !Number.isSafeInteger(quantity) ||
        quantity < 1 || quantity > 99 || seen.has(bookId)) {
      throw preOrderError('PRE_ORDER_VOLUME_ITEM_INVALID', `Invalid or duplicate volume ${index + 1}`, 400)
    }
    seen.add(bookId)
    return { book_id: bookId, edition, quantity }
  })

  const deliveryCompanyKey = String(input.delivery_company_key ?? '').trim().toLowerCase()
  if (!DELIVERY_KEY.test(deliveryCompanyKey)) {
    throw preOrderError('PRE_ORDER_VOLUME_DELIVERY_INVALID', 'Choose an available delivery company', 400)
  }

  const signatureRequested = input.signature_requested ?? false
  if (typeof signatureRequested !== 'boolean') {
    throw preOrderError('PRE_ORDER_VOLUME_SIGNATURE_INVALID', 'Invalid signature selection', 400)
  }

  return {
    items: items.sort((a, b) => a.book_id.localeCompare(b.book_id)),
    delivery_company_key: deliveryCompanyKey,
    signature_requested: signatureRequested,
  }
}
