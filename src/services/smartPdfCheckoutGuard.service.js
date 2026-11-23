import { supabase } from '../config/supabase.js'
import { evaluateSmartPdfEligibility, smartPdfUsdCents } from './smartPdfPolicy.service.js'
import { currentSmartPdfCampaignWindow, priceSmartPdfCandidate } from './smartPdfCampaign.service.js'
import { verifySmartPdfOfferToken, SmartPdfOfferTokenError } from './smartPdfOfferToken.service.js'

function changed() {
  throw new SmartPdfOfferTokenError()
}

export function hasSmartPdfOfferMarker(cartItem) {
  return Boolean(cartItem && Object.prototype.hasOwnProperty.call(cartItem, 'smart_pdf_offer_token'))
}

export async function applySmartPdfOfferCheckout(cartItem, orderItem, {
  readerId, db = supabase, now = Date.now(), secret = process.env.JWT_SECRET,
} = {}) {
  if (!hasSmartPdfOfferMarker(cartItem)) changed()
  const claims = verifySmartPdfOfferToken(cartItem.smart_pdf_offer_token, { readerId, now, secret })
  const id = String(orderItem?.product_id || '').trim().toLowerCase()
  if (id !== claims.product_id || String(orderItem?.author_page_id || '').toLowerCase() !== claims.author_page_id ||
      String(orderItem?.product_type || '').toLowerCase() !== 'pdf' ||
      Number(orderItem?.quantity) !== 1 ||
      smartPdfUsdCents(cartItem?.price_value) !== claims.promotion_cents ||
      smartPdfUsdCents(orderItem?.unit_price_usd) !== claims.author_cents ||
      (cartItem?.discover_promotion_rotation_key !== undefined && String(cartItem.discover_promotion_rotation_key) !== claims.rotation_key) ||
      (cartItem?.discover_promotion_expires_at !== undefined && Date.parse(String(cartItem.discover_promotion_expires_at)) !== claims.expires_at) ||
      (cartItem?.discover_promotion_story_language !== undefined && String(cartItem.discover_promotion_story_language) !== claims.language)) changed()
  const productResult = await db.from('author_store_products')
    .select('id,author_page_id,product_type,status,title,author_name,novel_type,category,genre,description,cover_url,original_price,sale_price,pdf_file_url,pdf_storage_key,created_at')
    .eq('id', claims.product_id).maybeSingle()
  if (productResult.error) throw productResult.error
  const product = productResult.data
  if (!product || String(product.author_page_id).toLowerCase() !== claims.author_page_id) changed()
  const authorResult = await db.from('author_pages')
    .select('id,status,page_name,page_username')
    .eq('id', claims.author_page_id).eq('status', 'active').maybeSingle()
  if (authorResult.error) throw authorResult.error
  const eligibility = evaluateSmartPdfEligibility(product, authorResult.data, claims.language)
  if (!eligibility.eligible) changed()
  const window = currentSmartPdfCampaignWindow(now)
  const offer = priceSmartPdfCandidate(eligibility.record, { window })
  if (!offer || offer.product_id !== claims.product_id || offer.author_page_id.toLowerCase() !== claims.author_page_id ||
      offer.story_language !== claims.language ||
      smartPdfUsdCents(offer.original_price_usd) !== claims.original_cents ||
      smartPdfUsdCents(offer.author_price_usd) !== claims.author_cents ||
      smartPdfUsdCents(offer.promotion_price_usd) !== claims.promotion_cents ||
      window.rotation_key !== claims.rotation_key || window.expiresAt !== claims.expires_at) changed()
  const unitPrice = claims.promotion_cents / 100
  return {
    ...orderItem,
    unit_price_usd: unitPrice,
    total_usd: Number((unitPrice * Number(orderItem.quantity)).toFixed(2)),
    discover_promotion_snapshot: {
      original_price_usd: claims.original_cents / 100,
      author_price_usd: claims.author_cents / 100,
      promotion_price_usd: unitPrice,
      discount_percent: Number(offer.discount_percent),
      discount_source: 'author',
      purchase_source: claims.placement,
      rotation_key: claims.rotation_key,
    },
  }
}
