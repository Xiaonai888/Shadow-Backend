import { supabase } from '../config/supabase.js'
import { requireCambodiaPhysicalBooks } from './physicalBookCountryGate.middleware.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function requireAuthorStorePhysicalBookCountry(req, res, next) {
  const items = req.body?.items
  if (!Array.isArray(items) || items.length === 0) return next()
  if (items.length > 100) {
    return res.status(400).json({ ok: false, code: 'INVALID_CART', message: 'Too many order items' })
  }

  const ids = items.map(item => String(item?.id || item?.product_id || item?.productId || '').trim())
  if (ids.some(id => !UUID.test(id))) {
    return res.status(400).json({ ok: false, code: 'INVALID_CART', message: 'Invalid order product' })
  }

  try {
    const uniqueIds = [...new Set(ids)]
    const { data, error } = await supabase
      .from('author_store_products')
      .select('id,product_type')
      .in('id', uniqueIds)

    if (error) throw error
    if (!Array.isArray(data) || data.length !== uniqueIds.length) {
      return res.status(400).json({ ok: false, code: 'INVALID_CART', message: 'Order product was not found' })
    }

    const containsBook = data.some(item => String(item.product_type || 'book').toLowerCase() !== 'pdf')
    if (!containsBook) return next()
    return requireCambodiaPhysicalBooks(req, res, next)
  } catch (error) {
    console.error('AUTHOR STORE BOOK COUNTRY ERROR:', String(error?.message || error))
    return res.status(503).json({ ok: false, code: 'BOOK_COUNTRY_UNAVAILABLE', message: 'Could not verify book availability' })
  }
}
