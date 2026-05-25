import { supabase } from '../config/supabase.js'

function getUserId(req) {
  return req.user?.user_id || req.user?.id || null
}

function normalizeImageArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean).slice(0, 5)

  if (!value) return []

  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed.filter(Boolean).slice(0, 5)
  } catch {}

  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 5)
}

function normalizeProduct(product) {
  if (!product) return null

  return {
    id: product.id,
    title: product.title || 'Untitled book',
    author_name: product.author_name || '',
    publisher: product.publisher || '',
    novel_type: product.novel_type || '',
    genre: product.genre || '',
    paper_type: product.paper_type || '',
    cover_type: product.cover_type || '',
    page_count: product.page_count || 0,
    cover_url: product.cover_url || '',
    gallery_image_urls: normalizeImageArray(product.gallery_image_urls),
    youtube_url: product.youtube_url || '',
    description: product.description || '',
    category: product.category || 'new_books',
    stock_status: product.stock_status || 'in_stock',
    price_usd: Number(product.price_usd || 0),
    old_price_usd: product.old_price_usd === null ? null : Number(product.old_price_usd || 0),
    stock_quantity: product.stock_quantity || 0,
    condition_label: product.condition_label || '',
    is_best_seller: Boolean(product.is_best_seller),
    is_discount: Boolean(product.is_discount),
    is_active: Boolean(product.is_active),
    sort_order: product.sort_order || 0,
    sold_out_at: product.sold_out_at,
    created_at: product.created_at,
    updated_at: product.updated_at,
  }
}

function normalizeWishlistRow(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    product_id: row.product_id,
    created_at: row.created_at,
    product: normalizeProduct(row.product),
  }
}

export async function getShadowMallWishlist(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Reader login is required' })
    }

    const { data, error } = await supabase
      .from('shadow_mall_wishlists')
      .select(`
        id,
        user_id,
        product_id,
        created_at,
        product:shadow_mall_products (
          id,
          title,
          author_name,
          publisher,
          novel_type,
          genre,
          paper_type,
          cover_type,
          page_count,
          cover_url,
          gallery_image_urls,
          youtube_url,
          description,
          category,
          stock_status,
          price_usd,
          old_price_usd,
          stock_quantity,
          condition_label,
          is_best_seller,
          is_discount,
          is_active,
          sort_order,
          sold_out_at,
          created_at,
          updated_at
        )
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })

    if (error) throw error

    const wishlist = (data || [])
      .map(normalizeWishlistRow)
      .filter((item) => item.product && item.product.is_active)

    return res.status(200).json({
      ok: true,
      wishlist,
      count: wishlist.length,
    })
  } catch (error) {
    console.error('GET SHADOW MALL WISHLIST ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to fetch Shadow Mall wishlist',
      error: error.message,
    })
  }
}

export async function addShadowMallWishlist(req, res) {
  try {
    const userId = getUserId(req)
    const productId = String(req.params.productId || req.body.product_id || '').trim()

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Reader login is required' })
    }

    if (!productId) {
      return res.status(400).json({ ok: false, message: 'Product id is required' })
    }

    const { data: product, error: productError } = await supabase
      .from('shadow_mall_products')
      .select('id, is_active')
      .eq('id', productId)
      .maybeSingle()

    if (productError) throw productError

    if (!product || !product.is_active) {
      return res.status(404).json({ ok: false, message: 'Book is not available' })
    }

    const { error } = await supabase
      .from('shadow_mall_wishlists')
      .upsert(
        {
          user_id: userId,
          product_id: productId,
        },
        {
          onConflict: 'user_id,product_id',
          ignoreDuplicates: true,
        }
      )

    if (error) throw error

    return res.status(200).json({
      ok: true,
      product_id: productId,
      wishlisted: true,
    })
  } catch (error) {
    console.error('ADD SHADOW MALL WISHLIST ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to save book',
      error: error.message,
    })
  }
}

export async function removeShadowMallWishlist(req, res) {
  try {
    const userId = getUserId(req)
    const productId = String(req.params.productId || '').trim()

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Reader login is required' })
    }

    if (!productId) {
      return res.status(400).json({ ok: false, message: 'Product id is required' })
    }

    const { error } = await supabase
      .from('shadow_mall_wishlists')
      .delete()
      .eq('user_id', userId)
      .eq('product_id', productId)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      product_id: productId,
      wishlisted: false,
    })
  } catch (error) {
    console.error('REMOVE SHADOW MALL WISHLIST ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to remove saved book',
      error: error.message,
    })
  }
}
