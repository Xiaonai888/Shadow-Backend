import { supabase } from '../config/supabase.js'

function normalizePublisher(publisher) {
  return {
    id: publisher.id,
    name: publisher.name || '',
    description: publisher.description || '',
    logo_url: publisher.logo_url || '',
    is_active: Boolean(publisher.is_active),
    sort_order: Number(publisher.sort_order || 0),
    created_at: publisher.created_at,
    updated_at: publisher.updated_at,
  }
}

function normalizeProduct(product) {
  return {
    id: product.id,
    title: product.title || '',
    author_name: product.author_name || '',
    publisher: product.publisher || '',
    publisher_id: product.publisher_id || null,
    cover_url: product.cover_url || '',
    category: product.category || '',
    stock_status: product.stock_status || '',
    price_usd: Number(product.price_usd || 0),
    old_price_usd: product.old_price_usd === null ? null : Number(product.old_price_usd || 0),
    is_active: Boolean(product.is_active),
    created_at: product.created_at,
    updated_at: product.updated_at,
  }
}

function cleanProductIds(value) {
  if (!Array.isArray(value)) return []

  return value
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0)
}

async function getPublisherById(id) {
  const { data, error } = await supabase
    .from('shadow_mall_publishers')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error) throw error
  return data || null
}

export async function getShadowMallPublishers(req, res) {
  try {
    const includeInactive = req.query.include_inactive === 'true'

    let query = supabase
      .from('shadow_mall_publishers')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })

    if (!includeInactive) query = query.eq('is_active', true)

    const { data, error } = await query

    if (error) throw error

    const publisherIds = (data || []).map((publisher) => publisher.id)
    const bookCounts = {}

    if (publisherIds.length) {
      const { data: products, error: productsError } = await supabase
        .from('shadow_mall_products')
        .select('publisher_id')
        .in('publisher_id', publisherIds)
        .eq('is_active', true)

      if (productsError) throw productsError

      ;(products || []).forEach((product) => {
        if (!product.publisher_id) return
        bookCounts[product.publisher_id] = (bookCounts[product.publisher_id] || 0) + 1
      })
    }

    return res.status(200).json({
      ok: true,
      publishers: (data || []).map((publisher) => ({
        ...normalizePublisher(publisher),
        book_count: bookCounts[publisher.id] || 0,
      })),
    })
  } catch (error) {
    console.error('GET SHADOW MALL PUBLISHERS ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load Shadow Mall publishers',
      error: error.message,
    })
  }
}

export async function createShadowMallPublisher(req, res) {
  try {
    const name = String(req.body.name || '').trim()

    if (!name) {
      return res.status(400).json({
        ok: false,
        message: 'Publisher name is required',
      })
    }

    const payload = {
      name,
      description: String(req.body.description || '').trim(),
      logo_url: String(req.body.logo_url || '').trim(),
      is_active: req.body.is_active === undefined ? true : Boolean(req.body.is_active),
      sort_order: Number(req.body.sort_order || 0),
      updated_at: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from('shadow_mall_publishers')
      .insert(payload)
      .select('*')
      .single()

    if (error) throw error

    return res.status(201).json({
      ok: true,
      publisher: normalizePublisher(data),
    })
  } catch (error) {
    console.error('CREATE SHADOW MALL PUBLISHER ERROR:', error)

    if (String(error.message || '').toLowerCase().includes('duplicate')) {
      return res.status(409).json({
        ok: false,
        message: 'Publisher name already exists',
      })
    }

    return res.status(500).json({
      ok: false,
      message: 'Failed to create Shadow Mall publisher',
      error: error.message,
    })
  }
}

export async function updateShadowMallPublisher(req, res) {
  try {
    const id = Number(req.params.id)

    if (!id) {
      return res.status(400).json({
        ok: false,
        message: 'Publisher id is required',
      })
    }

    const payload = {
      updated_at: new Date().toISOString(),
    }

    if (req.body.name !== undefined) payload.name = String(req.body.name || '').trim()
    if (req.body.description !== undefined) payload.description = String(req.body.description || '').trim()
    if (req.body.logo_url !== undefined) payload.logo_url = String(req.body.logo_url || '').trim()
    if (req.body.is_active !== undefined) payload.is_active = Boolean(req.body.is_active)
    if (req.body.sort_order !== undefined) payload.sort_order = Number(req.body.sort_order || 0)

    if (payload.name === '') {
      return res.status(400).json({
        ok: false,
        message: 'Publisher name is required',
      })
    }

    const { data, error } = await supabase
      .from('shadow_mall_publishers')
      .update(payload)
      .eq('id', id)
      .select('*')
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      publisher: normalizePublisher(data),
    })
  } catch (error) {
    console.error('UPDATE SHADOW MALL PUBLISHER ERROR:', error)

    if (String(error.message || '').toLowerCase().includes('duplicate')) {
      return res.status(409).json({
        ok: false,
        message: 'Publisher name already exists',
      })
    }

    return res.status(500).json({
      ok: false,
      message: 'Failed to update Shadow Mall publisher',
      error: error.message,
    })
  }
}

export async function deleteShadowMallPublisher(req, res) {
  try {
    const id = Number(req.params.id)

    if (!id) {
      return res.status(400).json({
        ok: false,
        message: 'Publisher id is required',
      })
    }

    const { data, error } = await supabase
      .from('shadow_mall_publishers')
      .update({
        is_active: false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      publisher: normalizePublisher(data),
    })
  } catch (error) {
    console.error('DELETE SHADOW MALL PUBLISHER ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to disable Shadow Mall publisher',
      error: error.message,
    })
  }
}

export async function getShadowMallPublisherProducts(req, res) {
  try {
    const publisherId = Number(req.params.id)

    if (!publisherId) {
      return res.status(400).json({
        ok: false,
        message: 'Publisher id is required',
      })
    }

    const publisher = await getPublisherById(publisherId)

    if (!publisher) {
      return res.status(404).json({
        ok: false,
        message: 'Publisher not found',
      })
    }

    const { data, error } = await supabase
      .from('shadow_mall_products')
      .select('id, title, author_name, publisher, publisher_id, cover_url, category, stock_status, price_usd, old_price_usd, is_active, created_at, updated_at')
      .eq('publisher_id', publisherId)
      .order('created_at', { ascending: false })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      publisher: normalizePublisher(publisher),
      products: (data || []).map(normalizeProduct),
    })
  } catch (error) {
    console.error('GET SHADOW MALL PUBLISHER PRODUCTS ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load publisher products',
      error: error.message,
    })
  }
}

export async function autoMatchShadowMallPublisherProducts(req, res) {
  try {
    const publisherId = Number(req.params.id)

    if (!publisherId) {
      return res.status(400).json({
        ok: false,
        message: 'Publisher id is required',
      })
    }

    const publisher = await getPublisherById(publisherId)

    if (!publisher) {
      return res.status(404).json({
        ok: false,
        message: 'Publisher not found',
      })
    }

    const { data, error } = await supabase
      .from('shadow_mall_products')
      .select('id, title, author_name, publisher, publisher_id, cover_url, category, stock_status, price_usd, old_price_usd, is_active, created_at, updated_at')
      .is('publisher_id', null)
      .ilike('publisher', `%${publisher.name}%`)
      .order('created_at', { ascending: false })
      .limit(100)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      publisher: normalizePublisher(publisher),
      matches: (data || []).map(normalizeProduct),
    })
  } catch (error) {
    console.error('AUTO MATCH SHADOW MALL PUBLISHER PRODUCTS ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to auto match publisher products',
      error: error.message,
    })
  }
}

export async function assignShadowMallPublisherProducts(req, res) {
  try {
    const publisherId = Number(req.params.id)
    const productIds = cleanProductIds(req.body.product_ids)

    if (!publisherId) {
      return res.status(400).json({
        ok: false,
        message: 'Publisher id is required',
      })
    }

    if (!productIds.length) {
      return res.status(400).json({
        ok: false,
        message: 'Product ids are required',
      })
    }

    const publisher = await getPublisherById(publisherId)

    if (!publisher) {
      return res.status(404).json({
        ok: false,
        message: 'Publisher not found',
      })
    }

    const { data, error } = await supabase
      .from('shadow_mall_products')
      .update({
        publisher_id: publisherId,
        publisher: publisher.name,
        updated_at: new Date().toISOString(),
      })
      .in('id', productIds)
      .select('id, title, author_name, publisher, publisher_id, cover_url, category, stock_status, price_usd, old_price_usd, is_active, created_at, updated_at')

    if (error) throw error

    return res.status(200).json({
      ok: true,
      publisher: normalizePublisher(publisher),
      products: (data || []).map(normalizeProduct),
    })
  } catch (error) {
    console.error('ASSIGN SHADOW MALL PUBLISHER PRODUCTS ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to assign publisher products',
      error: error.message,
    })
  }
}

export async function removeShadowMallPublisherProducts(req, res) {
  try {
    const publisherId = Number(req.params.id)
    const productIds = cleanProductIds(req.body.product_ids)

    if (!publisherId) {
      return res.status(400).json({
        ok: false,
        message: 'Publisher id is required',
      })
    }

    if (!productIds.length) {
      return res.status(400).json({
        ok: false,
        message: 'Product ids are required',
      })
    }

    const { data, error } = await supabase
      .from('shadow_mall_products')
      .update({
        publisher_id: null,
        updated_at: new Date().toISOString(),
      })
      .eq('publisher_id', publisherId)
      .in('id', productIds)
      .select('id, title, author_name, publisher, publisher_id, cover_url, category, stock_status, price_usd, old_price_usd, is_active, created_at, updated_at')

    if (error) throw error

    return res.status(200).json({
      ok: true,
      products: (data || []).map(normalizeProduct),
    })
  } catch (error) {
    console.error('REMOVE SHADOW MALL PUBLISHER PRODUCTS ERROR:', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to remove publisher products',
      error: error.message,
    })
  }
}
