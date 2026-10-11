import { supabase } from '../config/supabase.js'

const CACHE_DURATION_MS = 5 * 60 * 1000
const FETCH_PAGE_SIZE = 500
const PRODUCT_COLUMNS = 'id, author_page_id, product_type, title, author_name, publisher, category, genre, cover_url, original_price, sale_price, stock_quantity, pre_order, best_seller, discount, status, created_at, updated_at'
let cachedSnapshot = null
let cacheExpiresAt = 0
let pendingSnapshot = null

function cleanLimit(value, fallback = 24, max = 60) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(Math.floor(number), 1), max)
}

function cleanText(value) {
  return String(value ?? '').trim()
}

function productStockStatus(product) {
  if (product.product_type === 'pdf') return 'digital'
  if (product.pre_order) return 'pre_order'
  return Number(product.stock_quantity || 0) > 0 ? 'in_stock' : 'sold_out'
}

function currentPrice(product) {
  const sale = Number(product.sale_price)
  if (Number.isFinite(sale) && sale > 0) return sale
  return Math.max(Number(product.original_price) || 0, 0)
}

function discountPercent(product) {
  const original = Number(product.original_price || 0)
  const current = currentPrice(product)
  return original > 0 && current < original
    ? Math.round(((original - current) / original) * 100)
    : 0
}

function publicReaderStoreProduct(product, authorPage, sales = 0) {
  return {
    id: product.id,
    author_page_id: product.author_page_id,
    page_name: cleanText(authorPage.page_name),
    page_username: cleanText(authorPage.page_username),
    author_avatar_url: cleanText(authorPage.avatar_url),
    product_type: product.product_type || 'book',
    title: cleanText(product.title),
    author_name: cleanText(product.author_name) || cleanText(authorPage.page_name),
    publisher: cleanText(product.publisher),
    category: cleanText(product.category),
    genre: cleanText(product.genre),
    cover_url: cleanText(product.cover_url),
    original_price: Number(product.original_price || 0),
    sale_price: Number(product.sale_price || 0),
    stock_status: productStockStatus(product),
    pre_order: Boolean(product.pre_order),
    best_seller: sales > 0,
    discount: discountPercent(product) > 0,
    discount_percent: discountPercent(product),
    sold_quantity: sales,
    created_at: product.created_at || null,
    updated_at: product.updated_at || product.created_at || null,
  }
}

async function loadAllProducts() {
  const result = []
  for (let from = 0; ; from += FETCH_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('author_store_products')
      .select(PRODUCT_COLUMNS)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + FETCH_PAGE_SIZE - 1)
    if (error) throw error
    result.push(...(data || []))
    if (!data || data.length < FETCH_PAGE_SIZE) break
  }
  return result
}

async function loadActiveAuthors(products) {
  const ids = [...new Set(products.map((product) => product.author_page_id).filter(Boolean))]
  const result = []
  for (let start = 0; start < ids.length; start += 80) {
    const { data, error } = await supabase
      .from('author_pages')
      .select('id, page_name, page_username, avatar_url, status, updated_at')
      .in('id', ids.slice(start, start + 80))
      .eq('status', 'active')
    if (error) throw error
    result.push(...(data || []))
  }
  return result
}

async function loadSalesCounts() {
  const counts = new Map()
  for (let from = 0; ; from += FETCH_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('author_store_orders')
      .select('id, status, order_status, items:author_store_order_items(product_id, quantity)')
      .eq('payment_status', 'paid')
      .order('created_at', { ascending: false })
      .range(from, from + FETCH_PAGE_SIZE - 1)
    if (error) throw error
    for (const order of data || []) {
      const status = cleanText(order.order_status || order.status).toLowerCase()
      if (['cancelled', 'canceled', 'refunded', 'failed', 'amount_mismatch'].includes(status)) continue
      for (const item of order.items || []) {
        if (!item.product_id) continue
        const quantity = Math.max(0, Math.floor(Number(item.quantity) || 0))
        const key = String(item.product_id)
        counts.set(key, (counts.get(key) || 0) + quantity)
      }
    }
    if (!data || data.length < FETCH_PAGE_SIZE) break
  }
  return counts
}

function newestFirst(a, b) {
  return String(b.created_at || '').localeCompare(String(a.created_at || ''))
}

function bestSellingFirst(a, b) {
  return b.sold_quantity - a.sold_quantity || newestFirst(a, b)
}

function shuffleDaily(products) {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Phnom_Penh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
  let seed = 2166136261
  for (const character of today) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619) >>> 0
  const result = [...products]
  for (let index = result.length - 1; index > 0; index--) {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    const nextIndex = (seed >>> 0) % (index + 1)
    ;[result[index], result[nextIndex]] = [result[nextIndex], result[index]]
  }
  return result
}

function pickEditorsBooks(available, bestSellers) {
  const picked = []
  const used = new Set()
  const include = (product) => {
    if (!product || used.has(String(product.id))) return
    used.add(String(product.id))
    picked.push(product)
  }
  const cheapest = [...available].sort((a, b) =>
    currentPrice(a) - currentPrice(b) || newestFirst(a, b)
  )
  for (const product of cheapest.slice(0, 3)) include(product)
  for (const product of bestSellers) {
    if (picked.length >= 6) break
    include(product)
  }
  for (const product of cheapest) {
    if (picked.length >= 6) break
    include(product)
  }
  return shuffleDaily(picked)
}

async function buildStoreSnapshot() {
  const rawProducts = await loadAllProducts()
  const [authorPages, salesCounts] = await Promise.all([
    loadActiveAuthors(rawProducts),
    loadSalesCounts(),
  ])
  const authorMap = new Map(authorPages.map((page) => [String(page.id), page]))
  const products = rawProducts
    .filter((product) => authorMap.has(String(product.author_page_id)))
    .map((product) => publicReaderStoreProduct(
      product,
      authorMap.get(String(product.author_page_id)),
      salesCounts.get(String(product.id)) || 0
    ))
  const byNewest = [...products].sort(newestFirst)
  const byUpdated = [...products].sort((a, b) =>
    String(b.updated_at || '').localeCompare(String(a.updated_at || ''))
  )
  const available = byNewest.filter((product) => product.stock_status !== 'sold_out')
  const bestSellers = available
    .filter((product) => product.sold_quantity > 0)
    .sort(bestSellingFirst)
    .map((product, index) => ({ ...product, best_seller_rank: index + 1 }))
  const discounts = available
    .filter((product) => product.discount_percent > 0)
    .sort((a, b) => b.discount_percent - a.discount_percent || newestFirst(a, b))
  const soldOut = byUpdated
    .filter((product) => product.product_type === 'book' && product.stock_status === 'sold_out' && product.sold_quantity > 0)
  const productCountByAuthor = new Map()
  const latestByAuthor = new Map()
  for (const product of products) {
    const key = String(product.author_page_id)
    productCountByAuthor.set(key, (productCountByAuthor.get(key) || 0) + 1)
    const current = latestByAuthor.get(key)
    if (!current || String(product.updated_at || '') > current) {
      latestByAuthor.set(key, product.updated_at || '')
    }
  }
  const featuredAuthors = authorPages
    .map((page) => ({
      author_page_id: page.id,
      page_name: cleanText(page.page_name),
      page_username: cleanText(page.page_username),
      avatar_url: cleanText(page.avatar_url),
      product_count: productCountByAuthor.get(String(page.id)) || 0,
      latest_product_at: latestByAuthor.get(String(page.id)) || '',
    }))
    .filter((author) => author.product_count > 0)
    .sort((a, b) => b.product_count - a.product_count ||
      String(b.latest_product_at).localeCompare(String(a.latest_product_at)))
    .slice(0, 10)
  return {
    products: byUpdated,
    featuredAuthors,
    sections: {
      from_author_stores: byUpdated,
      editors_picks: pickEditorsBooks(available, bestSellers),
      best_sellers: bestSellers,
      discount_books: discounts,
      new_books: available,
      sold_out: soldOut,
      you_might_like: available,
    },
  }
}

async function getStoreSnapshot() {
  if (cachedSnapshot && Date.now() < cacheExpiresAt) return cachedSnapshot
  if (pendingSnapshot) return pendingSnapshot
  pendingSnapshot = buildStoreSnapshot()
    .then((snapshot) => {
      cachedSnapshot = snapshot
      cacheExpiresAt = Date.now() + CACHE_DURATION_MS
      return snapshot
    })
    .finally(() => {
      pendingSnapshot = null
    })
  return pendingSnapshot
}

export async function getReaderStoreHome(req, res) {
  try {
    const snapshot = await getStoreSnapshot()
    if (String(req.query.browse || '') === '1') {
      const section = cleanText(req.query.section || 'you_might_like')
      const source = snapshot.sections[section]
      if (!source) return res.status(400).json({ ok: false, message: 'Invalid store section' })
      const filter = cleanText(req.query.filter || 'all').toLowerCase()
      if (!['all', 'book', 'pdf', 'under3'].includes(filter)) {
        return res.status(400).json({ ok: false, message: 'Invalid store filter' })
      }
      const search = cleanText(req.query.search).slice(0, 100).toLocaleLowerCase()
      const list = source.filter((product) =>
        (filter !== 'book' || product.product_type === 'book') &&
        (filter !== 'pdf' || product.product_type === 'pdf') &&
        (filter !== 'under3' || currentPrice(product) < 3) &&
        (!search || [product.title, product.author_name, product.page_name, product.category, product.genre, product.publisher]
          .some((value) => cleanText(value).toLocaleLowerCase().includes(search)))
      )
      const limit = cleanLimit(req.query.limit, 9, 30)
      const page = cleanLimit(req.query.page, 1, 100000)
      const from = (page - 1) * limit
      return res.status(200).json({
        ok: true,
        section,
        products: list.slice(from, from + limit),
        page,
        limit,
        total: list.length,
        total_pages: Math.ceil(list.length / limit),
        has_more: from + limit < list.length,
      })
    }
    const limit = cleanLimit(req.query.limit)
    const sections = snapshot.sections
    return res.status(200).json({
      ok: true,
      products: snapshot.products.slice(0, limit),
      featured_authors: snapshot.featuredAuthors,
      editors_picks: sections.editors_picks,
      sections_has_more: { you_might_like: sections.you_might_like.length > 9 },
      sections: {
        from_author_stores: sections.from_author_stores.slice(0, 6),
        editors_picks: sections.editors_picks,
        best_sellers: sections.best_sellers.slice(0, 6),
        discount_books: sections.discount_books.slice(0, 6),
        new_books: sections.new_books.slice(0, 6),
        sold_out: sections.sold_out.slice(0, 6),
        you_might_like: sections.you_might_like.slice(0, 9),
      },
    })
  } catch (error) {
    console.error('GET READER STORE HOME ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: error.message || 'Failed to load Reader Store',
    })
  }
}
