import { getCurrentDiscoverAuthorStorePromotions } from '../controllers/discoverAuthorStorePromotion.controller.js'

function productIdOf(item) {
  return String(item?.id || item?.product_id || item?.productId || '').trim()
}

function hasPromotionMarker(item) {
  return Boolean(item && (
    Object.prototype.hasOwnProperty.call(item, 'discover_promotion_rotation_key') ||
    Object.prototype.hasOwnProperty.call(item, 'discover_promotion_expires_at')
  ))
}

function toCents(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return null
  const cents = Math.round(number * 100)
  return Number.isSafeInteger(cents) && Math.abs(number * 100 - cents) < 0.001
    ? cents
    : null
}

function promotionChanged() {
  const error = new Error('This promotion has ended or the product price has changed. Please return to Discover and add the product again.')
  error.statusCode = 409
  error.code = 'AUTHOR_STORE_PROMOTION_CHANGED'
  return error
}

export async function applyDiscoverAuthorStoreCheckoutPrices(cartItems, orderItems) {
  const requestedItems = Array.isArray(cartItems)
    ? cartItems.filter((item) => productIdOf(item))
    : []

  if (!requestedItems.some(hasPromotionMarker)) return orderItems
  if (!Array.isArray(orderItems) || requestedItems.length !== orderItems.length) {
    throw promotionChanged()
  }

  const rotation = await getCurrentDiscoverAuthorStorePromotions()
  const expiresAt = Number(rotation?.expiresAt)

  if (!rotation || !Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
    throw promotionChanged()
  }

  const offers = new Map(
    (rotation.promotions || []).map((offer) => [String(offer.product_id), offer])
  )

  return orderItems.map((orderItem, index) => {
    const requested = requestedItems[index]
    if (productIdOf(requested) !== String(orderItem.product_id)) {
      throw promotionChanged()
    }

    if (!hasPromotionMarker(requested)) return orderItem

    const offer = offers.get(String(orderItem.product_id))
    const type = String(orderItem.product_type || '').toLowerCase()
    const rotationKey = String(requested.discover_promotion_rotation_key || '')
    const submittedExpiry = Date.parse(String(requested.discover_promotion_expires_at || ''))
    const actualPrice = toCents(orderItem.unit_price_usd)
    const authorPrice = toCents(offer?.author_price_usd)
    const promotionPrice = toCents(offer?.promotion_price_usd)
    const displayedPrice = toCents(requested.price_value)
    const originalPrice = toCents(offer?.original_price_usd)

    if (
      !offer ||
      rotationKey !== String(rotation.rotation_key) ||
      submittedExpiry !== expiresAt ||
      Date.now() >= expiresAt ||
      String(offer.author_page_id) !== String(orderItem.author_page_id) ||
      String(offer.product_type).toLowerCase() !== type ||
      actualPrice === null ||
      authorPrice !== actualPrice ||
      promotionPrice === null ||
      displayedPrice !== promotionPrice ||
      promotionPrice > authorPrice ||
      originalPrice === null ||
      (type === 'book' && promotionPrice !== authorPrice) ||
      (type === 'pdf' && promotionPrice > Math.max(1, Math.floor(originalPrice * 0.8))) ||
      !['book', 'pdf'].includes(type)
    ) {
      throw promotionChanged()
    }

    const unitPrice = promotionPrice / 100
    return {
      ...orderItem,
      unit_price_usd: unitPrice,
      total_usd: Number((unitPrice * Number(orderItem.quantity)).toFixed(2)),
    }
  })
}
