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
