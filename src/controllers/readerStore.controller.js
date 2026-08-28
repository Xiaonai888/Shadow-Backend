import { supabase } from '../config/supabase.js'

function cleanLimit(value, fallback = 24, max = 60) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(Math.floor(number), 1), max)
}

function productStockStatus(product) {
  if (product.product_type === 'pdf') return 'digital'
  if (product.pre_order) return 'pre_order'
  return Number(product.stock_quantity || 0) > 0 ? 'in_stock' : 'sold_out'
}

function publicReaderStoreProduct(product, authorPage) {
  return {
    id: product.id,
    author_page_id: product.author_page_id,
    page_name: authorPage.page_name || '',
    page_username: authorPage.page_username || '',
    author_avatar_url:
      authorPage.avatar_url ||
      authorPage.profile_image_url ||
      authorPage.logo_url ||
      '',
    product_type: product.product_type || 'book',
    title: product.title || '',
    author_name: product.author_name || authorPage.page_name || '',
    publisher: product.publisher || '',
    category: product.category || '',
    genre: product.genre || '',
    cover_url: product.cover_url || '',
    original_price: Number(product.original_price || 0),
    sale_price: Number(product.sale_price || 0),
    stock_status: productStockStatus(product),
    pre_order: Boolean(product.pre_order),
    best_seller: Boolean(product.best_seller),
    discount: Boolean(product.discount),
    updated_at: product.updated_at || product.created_at || null,
  }
}

export async function getReaderStoreHome(req, res) {
  try {
    const limit = cleanLimit(req.query.limit)

    const { data: products, error: productsError } = await supabase
      .from('author_store_products')
      .select(
        'id, author_page_id, product_type, title, author_name, publisher, category, genre, cover_url, original_price, sale_price, stock_quantity, pre_order, best_seller, discount, status, created_at, updated_at'
      )
      .eq('status', 'active')
      .order('updated_at', { ascending: false })
      .limit(Math.max(limit * 4, 80))

    if (productsError) throw productsError

    const authorPageIds = [
      ...new Set((products || []).map((item) => item.author_page_id).filter(Boolean)),
    ]

    if (!authorPageIds.length) {
      return res.status(200).json({
        ok: true,
        products: [],
        featured_authors: [],
        editors_picks: [],
      })
    }

    const { data: authorPages, error: authorPagesError } = await supabase
      .from('author_pages')
      .select(
        'id, page_name, page_username, avatar_url, profile_image_url, logo_url, status, updated_at'
      )
      .in('id', authorPageIds)
      .eq('status', 'active')

    if (authorPagesError) throw authorPagesError

    const authorPageMap = new Map(
      (authorPages || []).map((page) => [String(page.id), page])
    )

    const publicProducts = (products || [])
      .filter((product) => authorPageMap.has(String(product.author_page_id)))
      .map((product) =>
        publicReaderStoreProduct(
          product,
          authorPageMap.get(String(product.author_page_id))
        )
      )

    const productCountByAuthor = new Map()
    const latestByAuthor = new Map()

    for (const product of publicProducts) {
      const key = String(product.author_page_id)
      productCountByAuthor.set(key, (productCountByAuthor.get(key) || 0) + 1)

      const current = latestByAuthor.get(key)
      if (!current || String(product.updated_at || '') > String(current || '')) {
        latestByAuthor.set(key, product.updated_at || '')
      }
    }

    const featuredAuthors = (authorPages || [])
      .map((page) => ({
        author_page_id: page.id,
        page_name: page.page_name || '',
        page_username: page.page_username || '',
        avatar_url:
          page.avatar_url ||
          page.profile_image_url ||
          page.logo_url ||
          '',
        product_count: productCountByAuthor.get(String(page.id)) || 0,
        latest_product_at: latestByAuthor.get(String(page.id)) || '',
      }))
      .filter((author) => author.product_count > 0)
      .sort((a, b) => {
        if (b.product_count !== a.product_count) {
          return b.product_count - a.product_count
        }
        return String(b.latest_product_at).localeCompare(String(a.latest_product_at))
      })
      .slice(0, 10)

    const editorsPicks = [...publicProducts]
      .sort((a, b) => {
        const aScore = (a.best_seller ? 4 : 0) + (a.discount ? 2 : 0)
        const bScore = (b.best_seller ? 4 : 0) + (b.discount ? 2 : 0)

        if (bScore !== aScore) return bScore - aScore
        return String(b.updated_at || '').localeCompare(String(a.updated_at || ''))
      })
      .slice(0, 8)

    return res.status(200).json({
      ok: true,
      products: publicProducts.slice(0, limit),
      featured_authors: featuredAuthors,
      editors_picks: editorsPicks,
    })
  } catch (error) {
    console.error('GET READER STORE HOME ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to load Reader Store',
    })
  }
}
