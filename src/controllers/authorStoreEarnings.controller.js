import { supabase } from '../config/supabase.js'

const money = (value) => Math.round((Number(value) || 0) * 100) / 100
const VALID_TYPES = new Set(['all', 'book', 'pdf'])

function positiveInteger(value, fallback, maximum) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 1
    ? Math.min(maximum, Math.floor(parsed))
    : fallback
}

function shippingCompanyName(value) {
  if (typeof value === 'string') return value
  return value?.name || value?.company_name || value?.shortName || value?.short_name || ''
}

export async function getMyAuthorStoreEarnings(req, res) {
  try {
    const userId = req.user?.user_id || req.user?.id
    if (!userId) return res.status(401).json({ ok: false, message: 'Unauthorized' })

    const type = String(req.query?.type || 'all').trim().toLowerCase()
    if (!VALID_TYPES.has(type)) {
      return res.status(400).json({ ok: false, message: 'Invalid earnings type' })
    }

    const page = positiveInteger(req.query?.page, 1, 100000)
    const limit = positiveInteger(req.query?.limit, 20, 50)

    const { data: authorPage, error: pageError } = await supabase
      .from('author_pages')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle()

    if (pageError) throw pageError
    if (!authorPage) return res.status(403).json({ ok: false, message: 'Please create an author page first' })

    const selectedColumns = 'id,order_id,order_number,created_at,delivery_fee_usd,delivery_company,items:author_store_order_items(id,product_title,product_type,total_price,platform_fee_usd,author_income_usd)'
    const relation = type === 'all' ? '' : ',matching_items:author_store_order_items!inner(product_type)'
    let query = supabase
      .from('author_store_orders')
      .select(selectedColumns + relation)
      .eq('author_page_id', authorPage.id)
      .eq('payment_status', 'paid')

    if (type !== 'all') query = query.eq('matching_items.product_type', type)

    const from = (page - 1) * limit
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + limit)

    if (error) throw error

    const fetchedOrders = Array.isArray(data) ? data : []
    const earnings = []
    let unitemizedOrders = 0

    for (const order of fetchedOrders.slice(0, limit)) {
      const items = Array.isArray(order.items) ? [...order.items] : []
      if (items.length === 0) {
        unitemizedOrders += 1
        continue
      }

      items.sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')))
      const company = shippingCompanyName(order.delivery_company)
      let deliveryRemaining = money(order.delivery_fee_usd)

      for (const [index, item] of items.entries()) {
        const itemType = String(item.product_type || '').toLowerCase()
        if (itemType !== 'book' && itemType !== 'pdf') continue

        const shippingFee = itemType === 'book' ? deliveryRemaining : 0
        if (itemType === 'book') deliveryRemaining = 0
        if (type !== 'all' && itemType !== type) continue

        earnings.push({
          id: `${order.id}:${item.id || index}`,
          type: itemType,
          title: item.product_title || '',
          orderId: order.order_number || order.order_id || order.id,
          date: order.created_at,
          price: money(item.total_price),
          shippingFee,
          shippingCompany: itemType === 'book' ? company : '',
          serviceFee: money(item.platform_fee_usd),
          creditedAmount: money(money(item.author_income_usd) + shippingFee),
        })
      }
    }

    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({
      ok: true,
      earnings,
      page,
      limit,
      type,
      has_next: fetchedOrders.length > limit,
      unitemized_orders: unitemizedOrders,
    })
  } catch (error) {
    console.error('GET MY AUTHOR STORE EARNINGS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load Author Store earnings' })
  }
}
