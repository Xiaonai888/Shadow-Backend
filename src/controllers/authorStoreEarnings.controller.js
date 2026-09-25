import { supabase } from '../config/supabase.js'

const money = (value) => Math.round((Number(value) || 0) * 100) / 100

export async function getMyAuthorStoreEarnings(req, res) {
  try {
    const userId = req.user?.user_id
    if (!userId) return res.status(401).json({ ok: false, message: 'Unauthorized' })

    const { data: authorPage, error: pageError } = await supabase
      .from('author_pages')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle()

    if (pageError) throw pageError
    if (!authorPage) return res.status(403).json({ ok: false, message: 'Please create an author page first' })

    const page = Math.max(1, Math.floor(Number(req.query.page) || 1))
    const limit = Math.min(50, Math.max(1, Math.floor(Number(req.query.limit) || 20)))
    const start = (page - 1) * limit
    const { data, error } = await supabase
      .from('author_store_orders')
      .select('id, order_id, order_number, created_at, delivery_fee_usd, delivery_company, items:author_store_order_items(id, product_title, product_type, total_price, platform_fee_usd, author_income_usd)')
      .eq('author_page_id', authorPage.id)
      .eq('payment_status', 'paid')
      .order('created_at', { ascending: false })
      .range(start, start + limit)

    if (error) throw error

    const orders = (data || []).slice(0, limit)
    const earnings = []
    let unitemizedOrders = 0

    for (const order of orders) {
      const items = Array.isArray(order.items) ? order.items : []
      if (!items.length) {
        unitemizedOrders += 1
        continue
      }

      const company = order.delivery_company
      const shippingCompany = typeof company === 'string'
        ? company
        : company?.name || company?.company_name || company?.shortName || company?.short_name || ''
      let shippingRemaining = money(order.delivery_fee_usd)

      for (const [index, item] of items.entries()) {
        const type = String(item.product_type || '').toLowerCase()
        if (type !== 'book' && type !== 'pdf') continue
        const shippingFee = type === 'book' ? shippingRemaining : 0
        if (type === 'book') shippingRemaining = 0

        earnings.push({
          id: `${order.id}:${item.id || index}`,
          type,
          title: item.product_title || '',
          orderId: order.order_number || order.order_id || order.id,
          date: order.created_at,
          price: money(item.total_price),
          shippingFee,
          shippingCompany: type === 'book' ? shippingCompany : '',
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
      has_next: (data || []).length > limit,
      unitemized_orders: unitemizedOrders,
    })
  } catch (error) {
    console.error('GET MY AUTHOR STORE EARNINGS ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load Author Store earnings' })
  }
}
