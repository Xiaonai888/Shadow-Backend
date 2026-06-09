import { supabase } from '../config/supabase.js'

const PRODUCT_TYPES = new Set(['book', 'pdf'])
const PRODUCT_STATUSES = new Set(['draft', 'active', 'hidden'])

function normalizePageUsername(username) {
  return String(username || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase()
}

function cleanText(value, fallback = '') {
  return String(value ?? fallback).trim()
}

function cleanNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function cleanInteger(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback
}

function publicProduct(product) {
  if (!product) return null

  return {
    id: product.id,
    author_page_id: product.author_page_id,
    user_id: product.user_id,
    product_type: product.product_type || 'book',
    type: product.product_type === 'pdf' ? 'PDF' : 'Book',
    title: product.title || '',
    category: product.category || 'New Release',
    description: product.description || '',
    original_price: Number(product.original_price || 0),
    sale_price: Number(product.sale_price || 0),
    status: product.status || 'draft',
    cover_url: product.cover_url || '',
    stock_quantity: Number(product.stock_quantity || 0),
    paper_type: product.paper_type || '',
    book_condition: product.book_condition || 'New',
    quality_percent: product.quality_percent,
    delivery_note: product.delivery_note || '',
    pre_order: Boolean(product.pre_order),
    pdf_file_url: product.pdf_file_url || '',
    pdf_file_name: product.pdf_file_name || '',
    page_count: Number(product.page_count || 0),
    access_rule: product.access_rule || '',
    created_at: product.created_at,
    updated_at: product.updated_at,
  }
}

async function getMyAuthorPage(userId) {
  const { data, error } = await supabase
    .from('author_pages')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle()

  if (error) throw error

  return data
}

export async function getMyAuthorStoreProducts(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    const { data, error } = await supabase
      .from('author_store_products')
      .select('*')
      .eq('author_page_id', authorPage.id)
      .order('created_at', { ascending: false })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      products: (data || []).map(publicProduct),
    })
  } catch (error) {
    console.error('GET MY AUTHOR STORE PRODUCTS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load store products', error: error.message })
  }
}

export async function getPublicAuthorStoreProducts(req, res) {
  try {
    const pageUsername = normalizePageUsername(req.params.pageUsername)

    if (!pageUsername) {
      return res.status(400).json({ ok: false, message: 'Page username is required' })
    }

    const { data: authorPage, error: pageError } = await supabase
      .from('author_pages')
      .select('id')
      .eq('page_username', pageUsername)
      .eq('status', 'active')
      .maybeSingle()

    if (pageError) throw pageError

    if (!authorPage) {
      return res.status(404).json({ ok: false, message: 'Author page not found' })
    }

    const { data, error } = await supabase
      .from('author_store_products')
      .select('*')
      .eq('author_page_id', authorPage.id)
      .eq('status', 'active')
      .order('created_at', { ascending: false })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      products: (data || []).map(publicProduct),
    })
  } catch (error) {
    console.error('GET PUBLIC AUTHOR STORE PRODUCTS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load store products', error: error.message })
  }
}

export async function createMyAuthorStoreProduct(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    const title = cleanText(req.body.title)
    const productTypeRaw = cleanText(req.body.product_type || req.body.productType || req.body.type || 'book').toLowerCase()
    const productType = productTypeRaw === 'pdf' ? 'pdf' : 'book'
    const statusRaw = cleanText(req.body.status || 'draft').toLowerCase()
    const status = PRODUCT_STATUSES.has(statusRaw) ? statusRaw : 'draft'
    const coverUrl = cleanText(req.body.cover_url || req.body.coverUrl)

    if (!title) {
      return res.status(400).json({ ok: false, message: 'Product title is required' })
    }

    if (!PRODUCT_TYPES.has(productType)) {
      return res.status(400).json({ ok: false, message: 'Invalid product type' })
    }

    if (!coverUrl) {
      return res.status(400).json({ ok: false, message: 'Product cover is required' })
    }

    const bookCondition = cleanText(req.body.book_condition || req.body.bookCondition || 'New')
    const qualityPercentRaw = req.body.quality_percent ?? req.body.qualityPercent ?? null
    const qualityPercent = qualityPercentRaw === null || qualityPercentRaw === ''
      ? null
      : cleanInteger(qualityPercentRaw, null)

    if (bookCondition === 'Second Hand' && (!qualityPercent || qualityPercent < 1 || qualityPercent > 100)) {
      return res.status(400).json({ ok: false, message: 'Book quality must be between 1% and 100%.' })
    }

    const payload = {
      author_page_id: authorPage.id,
      user_id: userId,
      product_type: productType,
      title,
      category: cleanText(req.body.category, 'New Release') || 'New Release',
      description: cleanText(req.body.description),
      original_price: cleanNumber(req.body.original_price ?? req.body.originalPrice, 0),
      sale_price: cleanNumber(req.body.sale_price ?? req.body.salePrice, 0),
      status,
      cover_url: coverUrl,
      stock_quantity: cleanInteger(req.body.stock_quantity ?? req.body.stockQuantity ?? req.body.stock, 0),
      paper_type: cleanText(req.body.paper_type || req.body.paperType),
      book_condition: bookCondition,
      quality_percent: bookCondition === 'Second Hand' ? qualityPercent : null,
      delivery_note: cleanText(req.body.delivery_note || req.body.deliveryNote),
      pre_order: Boolean(req.body.pre_order ?? req.body.preOrder),
      pdf_file_url: cleanText(req.body.pdf_file_url || req.body.pdfFileUrl),
      pdf_file_name: cleanText(req.body.pdf_file_name || req.body.pdfFileName),
      page_count: cleanInteger(req.body.page_count ?? req.body.pageCount, 0),
      access_rule: cleanText(req.body.access_rule || req.body.accessRule),
      updated_at: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from('author_store_products')
      .insert(payload)
      .select()
      .single()

    if (error) throw error

    return res.status(201).json({
      ok: true,
      message: 'Product created',
      product: publicProduct(data),
    })
  } catch (error) {
    console.error('CREATE MY AUTHOR STORE PRODUCT ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to create product', error: error.message })
  }
}

export async function updateMyAuthorStoreProduct(req, res) {
  try {
    const userId = req.user?.user_id
    const productId = req.params.productId

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!productId) {
      return res.status(400).json({ ok: false, message: 'Product ID is required' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    const title = cleanText(req.body.title)
    const productTypeRaw = cleanText(req.body.product_type || req.body.productType || req.body.type || 'book').toLowerCase()
    const productType = productTypeRaw === 'pdf' ? 'pdf' : 'book'
    const statusRaw = cleanText(req.body.status || 'draft').toLowerCase()
    const status = PRODUCT_STATUSES.has(statusRaw) ? statusRaw : 'draft'
    const coverUrl = cleanText(req.body.cover_url || req.body.coverUrl)

    if (!title) {
      return res.status(400).json({ ok: false, message: 'Product title is required' })
    }

    if (!PRODUCT_TYPES.has(productType)) {
      return res.status(400).json({ ok: false, message: 'Invalid product type' })
    }

    if (!coverUrl) {
      return res.status(400).json({ ok: false, message: 'Product cover is required' })
    }

    const bookCondition = cleanText(req.body.book_condition || req.body.bookCondition || 'New')
    const qualityPercentRaw = req.body.quality_percent ?? req.body.qualityPercent ?? null
    const qualityPercent = qualityPercentRaw === null || qualityPercentRaw === ''
      ? null
      : cleanInteger(qualityPercentRaw, null)

    if (bookCondition === 'Second Hand' && (!qualityPercent || qualityPercent < 1 || qualityPercent > 100)) {
      return res.status(400).json({ ok: false, message: 'Book quality must be between 1% and 100%.' })
    }

    const payload = {
      product_type: productType,
      title,
      category: cleanText(req.body.category, 'New Release') || 'New Release',
      description: cleanText(req.body.description),
      original_price: cleanNumber(req.body.original_price ?? req.body.originalPrice, 0),
      sale_price: cleanNumber(req.body.sale_price ?? req.body.salePrice, 0),
      status,
      cover_url: coverUrl,
      stock_quantity: cleanInteger(req.body.stock_quantity ?? req.body.stockQuantity ?? req.body.stock, 0),
      paper_type: cleanText(req.body.paper_type || req.body.paperType),
      book_condition: bookCondition,
      quality_percent: bookCondition === 'Second Hand' ? qualityPercent : null,
      delivery_note: cleanText(req.body.delivery_note || req.body.deliveryNote),
      pre_order: Boolean(req.body.pre_order ?? req.body.preOrder),
      pdf_file_url: cleanText(req.body.pdf_file_url || req.body.pdfFileUrl),
      pdf_file_name: cleanText(req.body.pdf_file_name || req.body.pdfFileName),
      page_count: cleanInteger(req.body.page_count ?? req.body.pageCount, 0),
      access_rule: cleanText(req.body.access_rule || req.body.accessRule),
      updated_at: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from('author_store_products')
      .update(payload)
      .eq('id', productId)
      .eq('author_page_id', authorPage.id)
      .eq('user_id', userId)
      .select()
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({ ok: false, message: 'Product not found' })
    }

    return res.status(200).json({
      ok: true,
      message: 'Product updated',
      product: publicProduct(data),
    })
  } catch (error) {
    console.error('UPDATE MY AUTHOR STORE PRODUCT ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to update product', error: error.message })
  }
}

export async function deleteMyAuthorStoreProduct(req, res) {
  try {
    const userId = req.user?.user_id
    const productId = req.params.productId

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!productId) {
      return res.status(400).json({ ok: false, message: 'Product ID is required' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    const { data, error } = await supabase
      .from('author_store_products')
      .delete()
      .eq('id', productId)
      .eq('author_page_id', authorPage.id)
      .eq('user_id', userId)
      .select('id')
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({ ok: false, message: 'Product not found' })
    }

    return res.status(200).json({
      ok: true,
      message: 'Product deleted',
      product_id: productId,
    })
  } catch (error) {
    console.error('DELETE MY AUTHOR STORE PRODUCT ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to delete product', error: error.message })
  }
}


function publicOrder(order) {
  return {
    id: order.id,
    author_page_id: order.author_page_id,
    buyer_id: order.buyer_id,
    order_number: order.order_number,
    buyer_name: order.buyer_name || '',
    buyer_phone: order.buyer_phone || '',
    buyer_email: order.buyer_email || '',
    delivery_address: order.delivery_address || '',
    subtotal: Number(order.subtotal || 0),
    delivery_fee: Number(order.delivery_fee || 0),
    total_amount: Number(order.total_amount || 0),
    payment_status: order.payment_status || 'pending',
    order_status: order.order_status || 'pending',
    note: order.note || '',
    created_at: order.created_at,
    updated_at: order.updated_at,
    items: Array.isArray(order.items)
      ? order.items.map((item) => ({
          id: item.id,
          product_id: item.product_id,
          product_title: item.product_title || '',
          product_type: item.product_type || 'book',
          cover_url: item.cover_url || '',
          quantity: Number(item.quantity || 1),
          unit_price: Number(item.unit_price || 0),
          total_price: Number(item.total_price || 0),
        }))
      : [],
  }
}

export async function getMyAuthorStoreOrders(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    const { data: orders, error } = await supabase
      .from('author_store_orders')
      .select('*, items:author_store_order_items(*)')
      .eq('author_page_id', authorPage.id)
      .order('created_at', { ascending: false })

    if (error) throw error

    const safeOrders = (orders || []).map(publicOrder)
    const revenue = safeOrders
      .filter((order) => order.payment_status === 'paid')
      .reduce((sum, order) => sum + Number(order.total_amount || 0), 0)

    return res.status(200).json({
      ok: true,
      orders: safeOrders,
      summary: {
        orders_count: safeOrders.length,
        revenue,
      },
    })
  } catch (error) {
    console.error('GET MY AUTHOR STORE ORDERS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load store orders', error: error.message })
  }
}

export async function createAuthorStoreOrder(req, res) {
  try {
    const buyerId = req.user?.user_id || null
    const pageUsername = normalizePageUsername(req.body.page_username || req.body.pageUsername)
    const items = Array.isArray(req.body.items) ? req.body.items : []

    if (!pageUsername) {
      return res.status(400).json({ ok: false, message: 'Page username is required' })
    }

    if (!items.length) {
      return res.status(400).json({ ok: false, message: 'Order items are required' })
    }

    const { data: authorPage, error: pageError } = await supabase
      .from('author_pages')
      .select('id')
      .eq('page_username', pageUsername)
      .eq('status', 'active')
      .maybeSingle()

    if (pageError) throw pageError

    if (!authorPage) {
      return res.status(404).json({ ok: false, message: 'Author page not found' })
    }

    const productIds = items.map((item) => item.product_id || item.productId).filter(Boolean)

    const { data: products, error: productsError } = await supabase
      .from('author_store_products')
      .select('*')
      .in('id', productIds)
      .eq('author_page_id', authorPage.id)
      .eq('status', 'active')

    if (productsError) throw productsError

    const productMap = new Map((products || []).map((product) => [product.id, product]))
    const orderItems = []

    for (const item of items) {
      const productId = item.product_id || item.productId
      const product = productMap.get(productId)

      if (!product) {
        return res.status(400).json({ ok: false, message: 'Invalid product in order' })
      }

      const quantity = Math.max(1, cleanInteger(item.quantity, 1))
      const unitPrice = Number(product.sale_price || product.original_price || 0)

      orderItems.push({
        product_id: product.id,
        product_title: product.title || '',
        product_type: product.product_type || 'book',
        cover_url: product.cover_url || '',
        quantity,
        unit_price: unitPrice,
        total_price: unitPrice * quantity,
      })
    }

    const subtotal = orderItems.reduce((sum, item) => sum + item.total_price, 0)
    const deliveryFee = cleanNumber(req.body.delivery_fee ?? req.body.deliveryFee, 0)
    const totalAmount = subtotal + deliveryFee
    const orderNumber = `AS-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`

    const { data: order, error: orderError } = await supabase
      .from('author_store_orders')
      .insert({
        author_page_id: authorPage.id,
        buyer_id: buyerId,
        order_number: orderNumber,
        buyer_name: cleanText(req.body.buyer_name || req.body.buyerName),
        buyer_phone: cleanText(req.body.buyer_phone || req.body.buyerPhone),
        buyer_email: cleanText(req.body.buyer_email || req.body.buyerEmail),
        delivery_address: cleanText(req.body.delivery_address || req.body.deliveryAddress),
        subtotal: subtotal,
        delivery_fee: deliveryFee,
        total_amount: totalAmount,
        payment_status: 'pending',
        order_status: 'pending',
        note: cleanText(req.body.note),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (orderError) throw orderError

    const { data: createdItems, error: itemsError } = await supabase
      .from('author_store_order_items')
      .insert(orderItems.map((item) => ({ ...item, order_id: order.id })))
      .select()

    if (itemsError) throw itemsError

    return res.status(201).json({
      ok: true,
      message: 'Order created',
      order: publicOrder({ ...order, items: createdItems || [] }),
    })
  } catch (error) {
    console.error('CREATE AUTHOR STORE ORDER ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to create order', error: error.message })
  }
}

const DEFAULT_AUTHOR_STORE_CATEGORIES = [
  'New Books',
  'Second Hand',
  'Best Seller',
  'PDF Books',
  'Pre-order',
  'Sold out',
  'Author Picks',
  'New Release',
]

function publicCategory(category) {
  return {
    id: category.id,
    author_page_id: category.author_page_id,
    user_id: category.user_id,
    name: category.name || '',
    sort_order: Number(category.sort_order || 0),
    is_default: Boolean(category.is_default),
    is_hidden: Boolean(category.is_hidden),
    created_at: category.created_at,
    updated_at: category.updated_at,
  }
}

async function ensureDefaultAuthorStoreCategories(authorPage, userId) {
  const { count, error: countError } = await supabase
    .from('author_store_categories')
    .select('id', { count: 'exact', head: true })
    .eq('author_page_id', authorPage.id)

  if (countError) throw countError

  if (Number(count || 0) > 0) return

  const rows = DEFAULT_AUTHOR_STORE_CATEGORIES.map((name, index) => ({
    author_page_id: authorPage.id,
    user_id: userId,
    name,
    sort_order: index,
    is_default: true,
    updated_at: new Date().toISOString(),
  }))

  const { error } = await supabase
    .from('author_store_categories')
    .insert(rows)

  if (error) throw error
}

export async function getMyAuthorStoreCategories(req, res) {
  try {
    const userId = req.user?.user_id

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    await ensureDefaultAuthorStoreCategories(authorPage, userId)

    const { data, error } = await supabase
      .from('author_store_categories')
      .select('*')
      .eq('author_page_id', authorPage.id)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      categories: (data || []).map(publicCategory),
    })
  } catch (error) {
    console.error('GET MY AUTHOR STORE CATEGORIES ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load store categories', error: error.message })
  }
}

export async function createMyAuthorStoreCategory(req, res) {
  try {
    const userId = req.user?.user_id
    const name = cleanText(req.body.name)

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!name) {
      return res.status(400).json({ ok: false, message: 'Category name is required' })
    }

    if (name.length > 40) {
      return res.status(400).json({ ok: false, message: 'Category name is too long' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    const { data: existing, error: existingError } = await supabase
      .from('author_store_categories')
      .select('id')
      .eq('author_page_id', authorPage.id)
      .ilike('name', name)
      .maybeSingle()

    if (existingError) throw existingError

    if (existing) {
      return res.status(409).json({ ok: false, message: 'Category already exists' })
    }

    const { data: lastCategory, error: lastError } = await supabase
      .from('author_store_categories')
      .select('sort_order')
      .eq('author_page_id', authorPage.id)
      .order('sort_order', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (lastError) throw lastError

    const nextSortOrder = Number(lastCategory?.sort_order || 0) + 1

    const { data, error } = await supabase
      .from('author_store_categories')
      .insert({
        author_page_id: authorPage.id,
        user_id: userId,
        name,
        sort_order: nextSortOrder,
        is_default: false,
        is_hidden: false,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (error) throw error

    return res.status(201).json({
      ok: true,
      message: 'Category created',
      category: publicCategory(data),
    })
  } catch (error) {
    console.error('CREATE MY AUTHOR STORE CATEGORY ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to create store category', error: error.message })
  }
}

export async function updateMyAuthorStoreCategory(req, res) {
  try {
    const userId = req.user?.user_id
    const categoryId = req.params.categoryId
    const name = cleanText(req.body.name)
    const isHidden = typeof req.body.is_hidden === 'boolean'
      ? req.body.is_hidden
      : typeof req.body.isHidden === 'boolean'
        ? req.body.isHidden
        : null

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!categoryId) {
      return res.status(400).json({ ok: false, message: 'Category ID is required' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    const { data: currentCategory, error: currentError } = await supabase
      .from('author_store_categories')
      .select('*')
      .eq('id', categoryId)
      .eq('author_page_id', authorPage.id)
      .eq('user_id', userId)
      .maybeSingle()

    if (currentError) throw currentError

    if (!currentCategory) {
      return res.status(404).json({ ok: false, message: 'Category not found' })
    }

    const isSoldOutSystem = currentCategory.name === 'Sold out'

    if (isSoldOutSystem && name && name !== 'Sold out') {
      return res.status(403).json({ ok: false, message: 'Sold out category cannot be renamed' })
    }

    const updates = {
      updated_at: new Date().toISOString(),
    }

    if (!isSoldOutSystem && name) {
      if (name.length > 40) {
        return res.status(400).json({ ok: false, message: 'Category name is too long' })
      }

      const { data: existing, error: existingError } = await supabase
        .from('author_store_categories')
        .select('id')
        .eq('author_page_id', authorPage.id)
        .ilike('name', name)
        .neq('id', categoryId)
        .maybeSingle()

      if (existingError) throw existingError

      if (existing) {
        return res.status(409).json({ ok: false, message: 'Category already exists' })
      }

      updates.name = name
    }

    if (isHidden !== null) {
      updates.is_hidden = isHidden
    }

    const { data, error } = await supabase
      .from('author_store_categories')
      .update(updates)
      .eq('id', categoryId)
      .eq('author_page_id', authorPage.id)
      .eq('user_id', userId)
      .select()
      .maybeSingle()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Category updated',
      category: publicCategory(data),
    })
  } catch (error) {
    console.error('UPDATE MY AUTHOR STORE CATEGORY ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to update store category', error: error.message })
  }
}

export async function deleteMyAuthorStoreCategory(req, res) {
  try {
    const userId = req.user?.user_id
    const categoryId = req.params.categoryId

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!categoryId) {
      return res.status(400).json({ ok: false, message: 'Category ID is required' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    const { data: currentCategory, error: currentError } = await supabase
  .from('author_store_categories')
  .select('name')
  .eq('id', categoryId)
  .eq('author_page_id', authorPage.id)
  .eq('user_id', userId)
  .maybeSingle()

if (currentError) throw currentError

if (!currentCategory) {
  return res.status(404).json({ ok: false, message: 'Category not found' })
}

if (currentCategory.name === 'Sold out') {
  return res.status(403).json({ ok: false, message: 'Sold out category cannot be deleted' })
}

    const { data, error } = await supabase
      .from('author_store_categories')
      .delete()
      .eq('id', categoryId)
      .eq('author_page_id', authorPage.id)
      .eq('user_id', userId)
      .select('id')
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({ ok: false, message: 'Category not found' })
    }

    return res.status(200).json({
      ok: true,
      message: 'Category deleted',
      category_id: categoryId,
    })
  } catch (error) {
    console.error('DELETE MY AUTHOR STORE CATEGORY ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to delete store category', error: error.message })
  }
}

export async function reorderMyAuthorStoreCategories(req, res) {
  try {
    const userId = req.user?.user_id
    const categoryIds = Array.isArray(req.body.category_ids)
      ? req.body.category_ids
      : Array.isArray(req.body.categoryIds)
        ? req.body.categoryIds
        : []

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!categoryIds.length) {
      return res.status(400).json({ ok: false, message: 'Category order is required' })
    }

    const authorPage = await getMyAuthorPage(userId)

    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    for (let index = 0; index < categoryIds.length; index += 1) {
      const { error } = await supabase
        .from('author_store_categories')
        .update({
          sort_order: index,
          updated_at: new Date().toISOString(),
        })
        .eq('id', categoryIds[index])
        .eq('author_page_id', authorPage.id)
        .eq('user_id', userId)

      if (error) throw error
    }

    const { data, error } = await supabase
      .from('author_store_categories')
      .select('*')
      .eq('author_page_id', authorPage.id)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Categories reordered',
      categories: (data || []).map(publicCategory),
    })
  } catch (error) {
    console.error('REORDER MY AUTHOR STORE CATEGORIES ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to reorder store categories', error: error.message })
  }
}
