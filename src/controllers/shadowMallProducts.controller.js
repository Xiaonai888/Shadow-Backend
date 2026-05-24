import { supabase } from '../config/supabase.js'

function toNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function toBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return fallback
}

function normalizeProduct(product) {
  return {
    id: product.id,
    title: product.title,
    author_name: product.author_name,
    cover_url: product.cover_url,
    description: product.description,
    category: product.category,
    stock_status: product.stock_status,
    price_usd: Number(product.price_usd || 0),
    old_price_usd: product.old_price_usd === null ? null : Number(product.old_price_usd || 0),
    stock_quantity: product.stock_quantity || 0,
    condition_label: product.condition_label,
    is_best_seller: Boolean(product.is_best_seller),
    is_discount: Boolean(product.is_discount),
    is_active: Boolean(product.is_active),
    sort_order: product.sort_order || 0,
    sold_out_at: product.sold_out_at,
    created_at: product.created_at,
    updated_at: product.updated_at,
  }
}

function normalizeCategory(value) {
  const category = String(value || 'new_books').trim()

  if (['new_books', 'second_hand', 'pre_order'].includes(category)) return category

  return 'new_books'
}

function normalizeStockStatus(value) {
  const status = String(value || 'in_stock').trim()

  if (['in_stock', 'sold_out', 'pre_order'].includes(status)) return status

  return 'in_stock'
}

export async function getShadowMallProducts(req, res) {
  try {
    const page = Math.max(toNumber(req.query.page, 1), 1)
    const limit = Math.min(Math.max(toNumber(req.query.limit, 20), 1), 100)
    const section = String(req.query.section || 'all').trim()
    const search = String(req.query.search || '').trim()
    const includeInactive = req.query.include_inactive === 'true'
    const from = (page - 1) * limit
    const to = from + limit - 1

    let query = supabase
      .from('shadow_mall_products')
      .select('*', { count: 'exact' })

    if (!includeInactive) query = query.eq('is_active', true)

    if (search) {
      query = query.or(`title.ilike.%${search}%,author_name.ilike.%${search}%`)
    }

    if (section === 'new_books') query = query.eq('category', 'new_books').neq('stock_status', 'sold_out')
    if (section === 'second_hand') query = query.eq('category', 'second_hand').neq('stock_status', 'sold_out')
    if (section === 'pre_order') query = query.or('category.eq.pre_order,stock_status.eq.pre_order')
    if (section === 'best_seller') query = query.eq('is_best_seller', true).neq('stock_status', 'sold_out')
    if (section === 'discount') query = query.eq('is_discount', true).neq('stock_status', 'sold_out')
    if (section === 'sold_out') query = query.eq('stock_status', 'sold_out')

    const { data, error, count } = await query
      .order(section === 'sold_out' ? 'sold_out_at' : 'sort_order', { ascending: section !== 'sold_out', nullsFirst: false })
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) throw error

    res.status(200).json({
      ok: true,
      products: (data || []).map(normalizeProduct),
      page,
      limit,
      total: count || 0,
      total_pages: Math.max(Math.ceil((count || 0) / limit), 1),
    })
  } catch (error) {
    console.error('GET SHADOW MALL PRODUCTS ERROR:', error)
    res.status(500).json({ ok: false, message: 'Failed to fetch Shadow Mall products', error: error.message })
  }
}

export async function getShadowMallHome(req, res) {
  try {
    const sections = [
      ['new_books', supabase.from('shadow_mall_products').select('*').eq('is_active', true).eq('category', 'new_books').neq('stock_status', 'sold_out').order('sort_order').order('created_at', { ascending: false }).limit(6)],
      ['second_hand', supabase.from('shadow_mall_products').select('*').eq('is_active', true).eq('category', 'second_hand').neq('stock_status', 'sold_out').order('sort_order').order('created_at', { ascending: false }).limit(6)],
      ['best_seller', supabase.from('shadow_mall_products').select('*').eq('is_active', true).eq('is_best_seller', true).neq('stock_status', 'sold_out').order('sort_order').order('created_at', { ascending: false }).limit(6)],
      ['discount', supabase.from('shadow_mall_products').select('*').eq('is_active', true).eq('is_discount', true).neq('stock_status', 'sold_out').order('sort_order').order('created_at', { ascending: false }).limit(6)],
      ['pre_order', supabase.from('shadow_mall_products').select('*').eq('is_active', true).or('category.eq.pre_order,stock_status.eq.pre_order').order('sort_order').order('created_at', { ascending: false }).limit(6)],
      ['sold_out', supabase.from('shadow_mall_products').select('*').eq('is_active', true).eq('stock_status', 'sold_out').order('sold_out_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(6)],
    ]

    const results = await Promise.all(sections.map(([, query]) => query))

    const response = {}

    results.forEach((result, index) => {
      const key = sections[index][0]

      if (result.error) throw result.error

      response[key] = (result.data || []).map(normalizeProduct)
    })

    res.status(200).json({ ok: true, sections: response })
  } catch (error) {
    console.error('GET SHADOW MALL HOME ERROR:', error)
    res.status(500).json({ ok: false, message: 'Failed to fetch Shadow Mall home', error: error.message })
  }
}

export async function getShadowMallProductById(req, res) {
  try {
    const { id } = req.params

    const { data, error } = await supabase
      .from('shadow_mall_products')
      .select('*')
      .eq('id', id)
      .single()

    if (error || !data) {
      return res.status(404).json({ ok: false, message: 'Shadow Mall product not found' })
    }

    res.status(200).json({ ok: true, product: normalizeProduct(data) })
  } catch (error) {
    console.error('GET SHADOW MALL PRODUCT ERROR:', error)
    res.status(500).json({ ok: false, message: 'Failed to fetch Shadow Mall product', error: error.message })
  }
}

export async function createShadowMallProduct(req, res) {
  try {
    const {
      title,
      author_name = '',
      cover_url = '',
      description = '',
      category = 'new_books',
      stock_status = 'in_stock',
      price_usd = 0,
      old_price_usd = null,
      stock_quantity = 0,
      condition_label = '',
      is_best_seller = false,
      is_discount = false,
      is_active = true,
      sort_order = 0,
    } = req.body

    if (!title) {
      return res.status(400).json({ ok: false, message: 'Product title is required' })
    }

    const payload = {
      title,
      author_name,
      cover_url,
      description,
      category: normalizeCategory(category),
      stock_status: normalizeStockStatus(stock_status),
      price_usd: toNumber(price_usd, 0),
      old_price_usd: old_price_usd === '' || old_price_usd === null ? null : toNumber(old_price_usd, 0),
      stock_quantity: toNumber(stock_quantity, 0),
      condition_label,
      is_best_seller: toBoolean(is_best_seller, false),
      is_discount: toBoolean(is_discount, false),
      is_active: toBoolean(is_active, true),
      sort_order: toNumber(sort_order, 0),
      sold_out_at: normalizeStockStatus(stock_status) === 'sold_out' ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from('shadow_mall_products')
      .insert(payload)
      .select()
      .single()

    if (error) throw error

    res.status(201).json({ ok: true, product: normalizeProduct(data) })
  } catch (error) {
    console.error('CREATE SHADOW MALL PRODUCT ERROR:', error)
    res.status(500).json({ ok: false, message: 'Failed to create Shadow Mall product', error: error.message })
  }
}

export async function updateShadowMallProduct(req, res) {
  try {
    const { id } = req.params

    const { data: current, error: currentError } = await supabase
      .from('shadow_mall_products')
      .select('stock_status')
      .eq('id', id)
      .single()

    if (currentError || !current) {
      return res.status(404).json({ ok: false, message: 'Shadow Mall product not found' })
    }

    const payload = { updated_at: new Date().toISOString() }
    const fields = ['title', 'author_name', 'cover_url', 'description', 'condition_label']

    fields.forEach((field) => {
      if (req.body[field] !== undefined) payload[field] = req.body[field]
    })

    if (req.body.category !== undefined) payload.category = normalizeCategory(req.body.category)
    if (req.body.stock_status !== undefined) payload.stock_status = normalizeStockStatus(req.body.stock_status)
    if (req.body.price_usd !== undefined) payload.price_usd = toNumber(req.body.price_usd, 0)
    if (req.body.old_price_usd !== undefined) payload.old_price_usd = req.body.old_price_usd === '' || req.body.old_price_usd === null ? null : toNumber(req.body.old_price_usd, 0)
    if (req.body.stock_quantity !== undefined) payload.stock_quantity = toNumber(req.body.stock_quantity, 0)
    if (req.body.is_best_seller !== undefined) payload.is_best_seller = toBoolean(req.body.is_best_seller, false)
    if (req.body.is_discount !== undefined) payload.is_discount = toBoolean(req.body.is_discount, false)
    if (req.body.is_active !== undefined) payload.is_active = toBoolean(req.body.is_active, true)
    if (req.body.sort_order !== undefined) payload.sort_order = toNumber(req.body.sort_order, 0)

    if (payload.stock_status === 'sold_out' && current.stock_status !== 'sold_out') {
      payload.sold_out_at = new Date().toISOString()
    }

    if (payload.stock_status && payload.stock_status !== 'sold_out') {
      payload.sold_out_at = null
    }

    const { data, error } = await supabase
      .from('shadow_mall_products')
      .update(payload)
      .eq('id', id)
      .select()
      .single()

    if (error) throw error

    res.status(200).json({ ok: true, product: normalizeProduct(data) })
  } catch (error) {
    console.error('UPDATE SHADOW MALL PRODUCT ERROR:', error)
    res.status(500).json({ ok: false, message: 'Failed to update Shadow Mall product', error: error.message })
  }
}

export async function deleteShadowMallProduct(req, res) {
  try {
    const { id } = req.params

    const { error } = await supabase
      .from('shadow_mall_products')
      .delete()
      .eq('id', id)

    if (error) throw error

    res.status(200).json({ ok: true })
  } catch (error) {
    console.error('DELETE SHADOW MALL PRODUCT ERROR:', error)
    res.status(500).json({ ok: false, message: 'Failed to delete Shadow Mall product', error: error.message })
  }
}
