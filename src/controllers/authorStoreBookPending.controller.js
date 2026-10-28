import { supabase } from '../config/supabase.js'

const ACTIVE_STATUSES = ['awaiting_reader', 'under_review']
const FILTERS = new Set(['all', ...ACTIVE_STATUSES])
const SUMMARY_PAGE_SIZE = 500

function positiveInteger(value, fallback, maximum) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 1 ? Math.min(parsed, maximum) : fallback
}

function cents(value) {
  const amount = Number(value)
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid held balance')
  return amount
}

function shippingCompanyName(value) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  return String(value.company_name || value.name || value.short_name || value.shortName || '')
}

async function readPendingSummary(authorPageId) {
  let totalCents = 0
  let totalOrders = 0
  let awaitingReader = 0
  let underReview = 0

  for (let offset = 0; ; offset += SUMMARY_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('author_store_book_payment_holds')
      .select('id,held_amount_cents,status')
      .eq('author_page_id', authorPageId)
      .in('status', ACTIVE_STATUSES)
      .order('id', { ascending: true })
      .range(offset, offset + SUMMARY_PAGE_SIZE - 1)

    if (error) throw error
    const rows = Array.isArray(data) ? data : []

    for (const row of rows) {
      totalCents += cents(row.held_amount_cents)
      totalOrders += 1
      if (row.status === 'awaiting_reader') awaitingReader += 1
      if (row.status === 'under_review') underReview += 1
      if (!Number.isSafeInteger(totalCents)) throw new Error('Held balance exceeds safe range')
    }

    if (rows.length < SUMMARY_PAGE_SIZE) break
  }

  return {
    total_pending: totalCents / 100,
    total_orders: totalOrders,
    awaiting_reader_count: awaitingReader,
    under_review_count: underReview,
  }
}

export async function getMyAuthorStoreBookPending(req, res) {
  res.set('Cache-Control', 'private, no-store')
  res.set('Vary', 'Authorization')

  try {
    const userId = req.user?.user_id || req.user?.id
    if (!userId) return res.status(401).json({ ok: false, message: 'Unauthorized' })

    const status = String(req.query?.status || 'all').trim().toLowerCase()
    if (!FILTERS.has(status)) {
      return res.status(400).json({ ok: false, message: 'Invalid pending status' })
    }

    const page = positiveInteger(req.query?.page, 1, 100000)
    const limit = positiveInteger(req.query?.limit, 10, 20)

    const { data: authorPage, error: pageError } = await supabase
      .from('author_pages')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle()

    if (pageError) throw pageError
    if (!authorPage) {
      return res.status(403).json({ ok: false, message: 'Please create an author page first' })
    }

    let holdsQuery = supabase
      .from('author_store_book_payment_holds')
      .select('id,order_id,held_amount_cents,status,delivery_company,tracking_number,proof_refs,created_at,updated_at', { count: 'exact' })
      .eq('author_page_id', authorPage.id)
      .in('status', ACTIVE_STATUSES)

    if (status !== 'all') holdsQuery = holdsQuery.eq('status', status)

    const from = (page - 1) * limit
    const { data: holds, error: holdsError, count } = await holdsQuery
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + limit - 1)

    if (holdsError) throw holdsError

    const selectedHolds = Array.isArray(holds) ? holds : []
    const orderIds = [...new Set(selectedHolds.map((hold) => hold.order_id).filter(Boolean))]
    let orderMap = new Map()

    if (orderIds.length) {
      const { data: orders, error: ordersError } = await supabase
        .from('author_store_orders')
        .select('id,order_id,order_number,buyer_name,delivery_company,order_status,status,created_at,items:author_store_order_items(product_title,product_type)')
        .eq('author_page_id', authorPage.id)
        .in('id', orderIds)

      if (ordersError) throw ordersError
      orderMap = new Map((orders || []).map((order) => [String(order.id), order]))
    }

    const orders = selectedHolds.map((hold) => {
      const order = orderMap.get(String(hold.order_id))
      const bookTitles = (Array.isArray(order?.items) ? order.items : [])
        .filter((item) => String(item.product_type || '').toLowerCase() === 'book')
        .map((item) => String(item.product_title || '').trim())
        .filter(Boolean)
      return {
        id: hold.id,
        orderId: order?.order_number || order?.order_id || hold.order_id,
        title: bookTitles.join(', ') || 'Physical Book',
        buyer: order?.buyer_name || 'Reader',
        amount: cents(hold.held_amount_cents) / 100,
        deliveryCompany: shippingCompanyName(hold.delivery_company || order?.delivery_company),
        trackingNumber: hold.tracking_number || '',
        date: order?.created_at || hold.created_at,
        orderStatus: order?.order_status || order?.status || '',
        status: hold.status,
        proofSent: Array.isArray(hold.proof_refs) && hold.proof_refs.length > 0,
      }
    })

    const summary = await readPendingSummary(authorPage.id)
    const total = Number(count || 0)

    return res.status(200).json({
      ok: true,
      summary,
      orders,
      page,
      limit,
      total,
      has_next: from + orders.length < total,
    })
  } catch (error) {
    console.error('GET AUTHOR STORE BOOK PENDING ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to load pending book payments' })
  }
}

export async function confirmMyAuthorStoreBookReceived(req, res) {
  res.set('Cache-Control', 'private, no-store')
  res.set('Vary', 'Authorization')

  const buyerId = String(req.user?.user_id || req.user?.id || '').trim()
  const orderId = String(req.params?.orderId || '').trim()
  const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

  if (!buyerId) {
    return res.status(401).json({ ok: false, message: 'Unauthorized' })
  }
  if (!uuidPattern.test(orderId)) {
    return res.status(400).json({ ok: false, message: 'Invalid order ID' })
  }
  if (!uuidPattern.test(buyerId)) {
    return res.status(401).json({ ok: false, message: 'Invalid reader session' })
  }

  try {
    const { data, error } = await supabase.rpc('confirm_author_store_book_received', {
      p_order_id: orderId,
      p_buyer_id: buyerId,
    })

    if (error) {
      if (error.code === '42501') {
        return res.status(403).json({ ok: false, message: 'Not authorized for this order' })
      }
      if (error.code === 'P0002') {
        return res.status(404).json({ ok: false, message: 'Book payment hold not found' })
      }
      if (error.code === '23514' || error.code === '40001') {
        return res.status(409).json({ ok: false, message: 'Receipt confirmation is not allowed in the current state' })
      }
      console.error('CONFIRM AUTHOR STORE BOOK RECEIVED ERROR:', {
        code: error.code,
        message: error.message,
      })
      return res.status(500).json({ ok: false, message: 'Could not confirm book receipt' })
    }

    // During migration, older SQL may still return "released". New SQL returns
    // "under_review" and keeps funds held until Owner Passkey approval.
    const validStatus = data?.status === 'under_review' || data?.status === 'released'
    if (!data || data.ok !== true || !validStatus || !data.hold_id || !data.order_id) {
      console.error('CONFIRM AUTHOR STORE BOOK RECEIVED INVALID RESULT', {
        status: data?.status || null,
      })
      return res.status(500).json({ ok: false, message: 'Could not verify receipt confirmation' })
    }

    return res.status(200).json({
      ok: true,
      already_confirmed: data.already_confirmed === true,
      order_id: data.order_id,
      hold_id: data.hold_id,
      status: data.status,
      reader_confirmed_at: data.reader_confirmed_at || null,
      awaiting_owner_passkey: data.status === 'under_review',
      released_at: data.status === 'released' ? (data.released_at || null) : null,
    })
  } catch (error) {
    console.error('CONFIRM AUTHOR STORE BOOK RECEIVED ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Could not confirm book receipt' })
  }
}
