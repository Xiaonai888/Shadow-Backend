import { supabase } from '../config/supabase.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RANGES = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}

function dateRange(input = {}) {
  const range = String(input.range || '24h').trim().toLowerCase()
  const now = Date.now()
  const kh = 7 * 60 * 60 * 1000
  if (range === 'all') return { from: null, to: null }
  if (range === 'custom') {
    const from = String(input.from || '')
    const to = String(input.to || '')
    const pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
    const start = Date.parse(from)
    const end = Date.parse(to)
    if (!pattern.test(from) || !pattern.test(to) || !Number.isFinite(start) || !Number.isFinite(end) || start >= end || end > now + 60000) {
      throw new Error('Invalid custom date range')
    }
    return { from: new Date(start).toISOString(), to: new Date(end).toISOString() }
  }
  if (range === 'today' || range === 'month') {
    const current = new Date(now + kh)
    const day = range === 'month' ? 1 : current.getUTCDate()
    const start = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), day) - kh
    return { from: new Date(start).toISOString(), to: new Date(now).toISOString() }
  }
  if (!Object.prototype.hasOwnProperty.call(RANGES, range)) throw new Error('Invalid date range')
  return { from: new Date(now - RANGES[range]).toISOString(), to: new Date(now).toISOString() }
}

export async function listAdminAuthorStorePdfManualReleaseHistory(req, res) {
  const role = String(req.admin?.role || '').toLowerCase()
  if (!['owner', 'admin'].includes(role)) {
    return res.status(403).json({ ok: false, message: 'Owner or Admin account required' })
  }

  try {
    const page = Math.min(Math.max(Number.parseInt(req.query.page, 10) || 1, 1), 100000)
    const search = String(req.query.q || '').replace(/^@/, '').trim().slice(0, 80)
    const { from, to } = dateRange(req.query)
    const start = (page - 1) * 10
    let query = supabase.from('author_store_pdf_manual_settlements')
      .select('id,order_id,buyer_id,bank_reference,verified_amount_usd,bank_paid_at,admin_id,admin_email,reason,created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })

    if (from) query = query.gte('created_at', from)
    if (to) query = query.lte('created_at', to)

    if (search) {
      const sanitized = search.replace(/[,()%*;"\\:]/g, ' ').trim()
      if (!sanitized) return res.status(400).json({ ok: false, message: 'Invalid search' })
      const [usersResult, ordersResult] = await Promise.all([
        supabase.from('users').select('id').or(`username.ilike.%${sanitized}%,name.ilike.%${sanitized}%`).limit(30),
        supabase.from('author_store_orders').select('id').ilike('order_id', `%${sanitized}%`).limit(30),
      ])
      if (usersResult.error) throw usersResult.error
      if (ordersResult.error) throw ordersResult.error
      const filters = [`bank_reference.ilike.%${sanitized}%`]
      const buyerIds = (usersResult.data || []).map((row) => row.id).filter(Boolean)
      const orderIds = (ordersResult.data || []).map((row) => row.id).filter(Boolean)
      if (UUID.test(sanitized)) buyerIds.push(sanitized)
      if (buyerIds.length) filters.push(`buyer_id.in.(${[...new Set(buyerIds)].join(',')})`)
      if (orderIds.length) filters.push(`order_id.in.(${orderIds.join(',')})`)
      query = query.or(filters.join(','))
    }

    const { data: settlements, count, error } = await query.range(start, start + 9)
    if (error) throw error
    const rows = settlements || []
    const orderIds = [...new Set(rows.map((row) => row.order_id).filter(Boolean))]
    const buyerIds = [...new Set(rows.map((row) => row.buyer_id).filter(Boolean))]
    const [ordersResult, usersResult, itemsResult, countsResult] = await Promise.all([
      orderIds.length ? supabase.from('author_store_orders')
        .select('id,order_id,buyer_id,buyer_name,payment_status,pdf_unlock_status')
        .in('id', orderIds) : Promise.resolve({ data: [], error: null }),
      buyerIds.length ? supabase.from('users').select('id,name,username').in('id', buyerIds)
        : Promise.resolve({ data: [], error: null }),
      orderIds.length ? supabase.from('author_store_order_items')
        .select('order_id,product_id,product_title,product_type,quantity')
        .in('order_id', orderIds).eq('product_type', 'pdf')
        : Promise.resolve({ data: [], error: null }),
      Promise.all(buyerIds.map(async (buyerId) => {
        const result = await supabase.from('author_store_pdf_manual_settlements')
          .select('id', { count: 'exact', head: true }).eq('buyer_id', buyerId)
        if (result.error) throw result.error
        return [buyerId, result.count || 0]
      })),
    ])

    for (const result of [ordersResult, usersResult, itemsResult]) {
      if (result.error) throw result.error
    }
    const orders = new Map((ordersResult.data || []).map((row) => [String(row.id), row]))
    const users = new Map((usersResult.data || []).map((row) => [String(row.id), row]))
    const counts = new Map(countsResult)
    const itemsByOrder = new Map()
    for (const item of itemsResult.data || []) {
      const key = String(item.order_id)
      if (!itemsByOrder.has(key)) itemsByOrder.set(key, [])
      itemsByOrder.get(key).push(item)
    }

    const productIds = [...new Set((itemsResult.data || []).map((item) => item.product_id).filter(Boolean))]
    const grantsResult = buyerIds.length && productIds.length
      ? await supabase.from('author_store_reader_downloads').select('buyer_id,product_id')
        .in('buyer_id', buyerIds).in('product_id', productIds)
      : { data: [], error: null }
    if (grantsResult.error) throw grantsResult.error
    const grants = new Set((grantsResult.data || []).map((row) => `${row.buyer_id}:${row.product_id}`))

    const items = rows.map((settlement) => {
      const order = orders.get(String(settlement.order_id)) || null
      const products = itemsByOrder.get(String(settlement.order_id)) || []
      const grantedCount = products.filter((item) => grants.has(`${settlement.buyer_id}:${item.product_id}`)).length
      const delivered = order?.payment_status === 'paid'
        && order?.pdf_unlock_status === 'unlocked'
        && products.length > 0 && grantedCount === products.length
      return {
        id: settlement.id,
        order_id: settlement.order_id,
        order_number: order?.order_id || '',
        buyer_id: settlement.buyer_id,
        buyer_name: users.get(String(settlement.buyer_id))?.name || order?.buyer_name || 'Reader',
        username: users.get(String(settlement.buyer_id))?.username || '',
        manual_count_for_reader: counts.get(settlement.buyer_id) || 0,
        pdf_count: products.length,
        granted_count: grantedCount,
        pdf_titles: products.map((product) => product.product_title).filter(Boolean),
        release_status: delivered ? 'delivered' : 'needs_recovery',
        amount_usd: settlement.verified_amount_usd,
        bank_reference: settlement.bank_reference,
        bank_paid_at: settlement.bank_paid_at,
        admin_email: settlement.admin_email,
        reason: settlement.reason,
        created_at: settlement.created_at,
      }
    })

    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({
      ok: true,
      page,
      limit: 10,
      total: count || 0,
      items,
      has_next: start + items.length < (count || 0),
      has_prev: page > 1,
    })
  } catch (error) {
    console.error('ADMIN PDF MANUAL HISTORY ERROR:', String(error?.message || error).slice(0, 250))
    const badRequest = String(error?.message || '').startsWith('Invalid')
    return res.status(badRequest ? 400 : 503).json({
      ok: false,
      message: badRequest ? error.message : 'Manual PDF release history is temporarily unavailable',
    })
  }
}
