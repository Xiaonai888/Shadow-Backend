import { supabase } from '../config/supabase.js'

const BATCH_SIZE = 500
const MAX_ROWS = 5000
const VALID_TYPES = new Set(['all', 'book', 'pdf'])
const VALID_STATUSES = new Set(['all', 'pending', 'available', 'paid', 'unknown'])
const VALID_SORTS = new Set([
  'author_earned', 'gross_sales', 'platform_earned',
  'transactions', 'pending', 'paid_out', 'latest',
])

function amount(value) {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function money(value) {
  return Number(amount(value).toFixed(2))
}

function positiveInt(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(1, parsed)) : fallback
}

function boundary(value, end = false) {
  if (!value) return null
  const text = String(value).trim()
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(text)
  const date = new Date(dayOnly ? `${text}T00:00:00+07:00` : text)
  if (Number.isNaN(date.getTime())) {
    const error = new Error('Invalid date range')
    error.statusCode = 400
    throw error
  }
  if (dayOnly && end) date.setTime(date.getTime() + 86400000)
  return date.toISOString()
}

function withRange(query, from, to) {
  let result = query
  if (from) result = result.gte('created_at', from)
  if (to) result = result.lt('created_at', to)
  return result
}

async function readAll(table, select, from, to, extra = (query) => query) {
  const rows = []
  for (let start = 0; start < MAX_ROWS; start += BATCH_SIZE) {
    const query = extra(withRange(
      supabase.from(table).select(select).order('created_at', { ascending: false }),
      from,
      to
    )).range(start, start + BATCH_SIZE - 1)
    const { data, error } = await query
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < BATCH_SIZE) break
  }
  return { rows, truncated: rows.length >= MAX_ROWS }
}

async function readByIds(table, columns, field, ids) {
  const rows = []
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .in(field, ids.slice(i, i + BATCH_SIZE))
    if (error) throw error
    rows.push(...(data || []))
  }
  return rows
}

function orderItems(order) {
  return Array.isArray(order.items) ? order.items : []
}

function productType(item) {
  const type = String(item.product_type || item.type || '').toLowerCase()
  return type === 'pdf' || type === 'book' ? type : 'unknown'
}

function orderTotals(order, type) {
  const items = orderItems(order)
  const included = type === 'all' ? items : items.filter((item) => productType(item) === type)
  if (type !== 'all' && !included.length) return null
  if (type === 'all') {
    return {
      gross: amount(order.product_subtotal_usd ?? order.subtotal_usd ?? order.subtotal),
      platform: amount(order.platform_fee_usd),
      author: amount(order.author_income_usd),
      book: items.some((item) => productType(item) === 'book'),
      pdf: items.some((item) => productType(item) === 'pdf'),
    }
  }
  return {
    gross: included.reduce((sum, item) => sum + amount(item.total_price ?? item.total_usd), 0),
    platform: included.reduce((sum, item) => sum + amount(item.platform_fee_usd), 0),
    author: included.reduce((sum, item) => sum + amount(item.author_income_usd), 0),
    book: type === 'book',
    pdf: type === 'pdf',
  }
}

function payoutStatus(row) {
  if (row.pending_payout_usd > 0) return 'pending'
  if (row.author_earnings_usd > row.paid_payout_usd) return 'available'
  if (row.paid_payout_usd > 0) return 'paid'
  return 'unknown'
}

function publicOrderId(order) {
  return String(order.order_id || order.order_number || order.id || '')
}

async function sources(from, to) {
  const [orders, withdrawals] = await Promise.all([
    readAll('author_store_orders', '*,items:author_store_order_items(*)', from, to,
      (query) => query.eq('payment_status', 'paid')),
    readAll('author_store_withdrawal_requests', '*', from, to,
      (query) => query.is('deleted_at', null)),
  ])
  const pageIds = [...new Set([
    ...orders.rows.map((order) => order.author_page_id),
    ...withdrawals.rows.map((row) => row.author_page_id),
  ].filter(Boolean).map(String))]
  const pages = await readByIds(
    'author_pages', 'id,user_id,page_name,page_username,page_slug', 'id', pageIds
  )
  const pageMap = new Map(pages.map((page) => [String(page.id), page]))
  const userIds = [...new Set([
    ...pages.map((page) => page.user_id),
    ...withdrawals.rows.map((row) => row.user_id),
  ].filter(Boolean).map(String))]
  const users = await readByIds('users', 'id,name,username', 'id', userIds)
  const userMap = new Map(users.map((user) => [String(user.id), user]))
  return { orders, withdrawals, pageMap, userMap }
}

function identity(pageId, userId, pageMap, userMap) {
  const page = pageMap.get(String(pageId || '')) || {}
  const id = String(userId || page.user_id || pageId || '')
  const user = userMap.get(id) || {}
  return {
    key: id,
    author_user_id: String(userId || page.user_id || ''),
    author_page_id: String(pageId || ''),
    author_name: user.name || page.page_name || 'Unknown Author',
    author_username: user.username || page.page_username || '',
  }
}

function aggregate(source, type) {
  const groups = new Map()
  function group(pageId, userId) {
    const owner = identity(pageId, userId, source.pageMap, source.userMap)
    if (!owner.key) return null
    if (!groups.has(owner.key)) {
      groups.set(owner.key, {
        ...owner,
        gross_sales_usd: 0,
        author_earnings_usd: 0,
        platform_income_usd: 0,
        transaction_count: 0,
        book_orders: 0,
        pdf_orders: 0,
        pending_payout_usd: 0,
        paid_payout_usd: 0,
        latest_income_at: null,
      })
    }
    return groups.get(owner.key)
  }
  for (const order of source.orders.rows) {
    const totals = orderTotals(order, type)
    if (!totals) continue
    const row = group(order.author_page_id, null)
    if (!row) continue
    row.gross_sales_usd += totals.gross
    row.platform_income_usd += totals.platform
    row.author_earnings_usd += totals.author
    row.transaction_count += 1
    if (totals.book) row.book_orders += 1
    if (totals.pdf) row.pdf_orders += 1
    if (!row.latest_income_at || order.created_at > row.latest_income_at) {
      row.latest_income_at = order.created_at
    }
  }
  for (const withdrawal of source.withdrawals.rows) {
    const row = group(withdrawal.author_page_id, withdrawal.user_id)
    if (!row) continue
    const status = String(withdrawal.status || '').toLowerCase()
    if (status === 'in_review' || status === 'approved') {
      row.pending_payout_usd += amount(withdrawal.amount_usd)
    } else if (status === 'paid') {
      row.paid_payout_usd += amount(withdrawal.paid_amount_usd ?? withdrawal.amount_usd)
    }
  }
  return [...groups.values()].filter((row) => type === 'all' || row.transaction_count > 0).map((row) => ({
    ...row,
    gross_sales_usd: money(row.gross_sales_usd),
    author_earnings_usd: money(row.author_earnings_usd),
    platform_income_usd: money(row.platform_income_usd),
    pending_payout_usd: money(row.pending_payout_usd),
    paid_payout_usd: money(row.paid_payout_usd),
    payout_status: payoutStatus(row),
  }))
}

export async function getAdminAuthorPageAuthors(req, res) {
  try {
    const from = boundary(req.query.from)
    const to = boundary(req.query.to, true)
    const type = String(req.query.type || 'all').toLowerCase()
    const status = String(req.query.status || 'all').toLowerCase()
    const search = String(req.query.q || '').trim().toLowerCase().slice(0, 120)
    const sort = String(req.query.sort || 'author_earned_desc').toLowerCase()
    const [sortField, direction] = sort.match(/^(.*)_(asc|desc)$/)?.slice(1) || []
    const page = positiveInt(req.query.page, 1, 100000)
    const limit = positiveInt(req.query.limit, 20, 50)
    if (!VALID_TYPES.has(type) || !VALID_STATUSES.has(status) || !VALID_SORTS.has(sortField)) {
      return res.status(400).json({ ok: false, message: 'Invalid income filter' })
    }
    const source = await sources(from, to)
    let rows = aggregate(source, type).filter((row) => {
      const matches = !search || [row.author_name, row.author_username, row.author_user_id, row.author_page_id]
        .some((value) => String(value || '').toLowerCase().includes(search))
      return matches && (status === 'all' || row.payout_status === status)
    })
    const summary = {
      gross_sales_usd: money(rows.reduce((sum, row) => sum + row.gross_sales_usd, 0)),
      author_earnings_usd: money(rows.reduce((sum, row) => sum + row.author_earnings_usd, 0)),
      platform_income_usd: money(rows.reduce((sum, row) => sum + row.platform_income_usd, 0)),
      pending_payout_usd: money(rows.reduce((sum, row) => sum + row.pending_payout_usd, 0)),
      paid_out_usd: money(rows.reduce((sum, row) => sum + row.paid_payout_usd, 0)),
      paid_orders: rows.reduce((sum, row) => sum + row.transaction_count, 0),
      author_count: rows.length,
    }
    const field = {
      author_earned: 'author_earnings_usd',
      gross_sales: 'gross_sales_usd',
      platform_earned: 'platform_income_usd',
      transactions: 'transaction_count',
      pending: 'pending_payout_usd',
      paid_out: 'paid_payout_usd',
      latest: 'latest_income_at',
    }[sortField]
    rows.sort((a, b) => {
      const av = field === 'latest_income_at' ? (a[field] ? Date.parse(a[field]) || 0 : 0) : amount(a[field])
      const bv = field === 'latest_income_at' ? (b[field] ? Date.parse(b[field]) || 0 : 0) : amount(b[field])
      const difference = direction === 'asc' ? av - bv : bv - av
      return difference || a.author_name.localeCompare(b.author_name)
    })
    const total = rows.length
    const pages = Math.max(1, Math.ceil(total / limit))
    const safePage = Math.min(page, pages)
    return res.status(200).json({
      ok: true,
      source: 'author_store',
      summary,
      items: rows.slice((safePage - 1) * limit, safePage * limit),
      pagination: {
        page: safePage,
        limit,
        total,
        total_pages: pages,
        has_prev: safePage > 1,
        has_next: safePage < pages,
      },
      payout_scope: 'all_book_pdf',
      truncated_source_scan: source.orders.truncated || source.withdrawals.truncated,
    })
  } catch (error) {
    console.error('GET ADMIN AUTHOR PAGE AUTHORS ERROR:', error)
    return res.status(error.statusCode || 500).json({
      ok: false,
      message: error.message || 'Failed to load Author Page author summary',
    })
  }
}

export async function getAdminAuthorPageAuthorTransactions(req, res) {
  try {
    const authorId = String(req.params.authorId || '')
    const type = String(req.query.type || 'all').toLowerCase()
    const from = boundary(req.query.from)
    const to = boundary(req.query.to, true)
    const page = positiveInt(req.query.page, 1, 100000)
    const limit = positiveInt(req.query.limit, 20, 50)
    if (!VALID_TYPES.has(type)) {
      return res.status(400).json({ ok: false, message: 'Invalid product type' })
    }
    const { data: pages, error: pageError } = await supabase
      .from('author_pages')
      .select('id,user_id')
      .eq('user_id', authorId)
    if (pageError) throw pageError
    const pageIds = (pages || []).map((item) => item.id)
    if (!pageIds.length) pageIds.push(authorId)
    const orders = await readAll('author_store_orders', '*,items:author_store_order_items(*)', from, to,
      (query) => query.eq('payment_status', 'paid').in('author_page_id', pageIds))
    const transactions = orders.rows.map((order) => {
      const totals = orderTotals(order, type)
      if (!totals) return null
      return {
        id: order.id,
        order_id: publicOrderId(order),
        created_at: order.created_at,
        paid_at: order.paid_at || null,
        author_page_id: order.author_page_id,
        aba_transaction_id: order.aba_transaction_id || '',
        order_status: order.order_status || order.status || '',
        gross_sales_usd: money(totals.gross),
        author_income_usd: money(totals.author),
        platform_fee_usd: money(totals.platform),
        items: orderItems(order).filter((item) => type === 'all' || productType(item) === type).map((item) => ({
          title: String(item.product_title || item.title || 'Product'),
          product_type: productType(item),
          quantity: Math.max(1, Math.floor(amount(item.quantity) || 1)),
          total_usd: money(item.total_price ?? item.total_usd),
          author_income_usd: money(item.author_income_usd),
          platform_fee_usd: money(item.platform_fee_usd),
        })),
      }
    }).filter(Boolean)
    const total = transactions.length
    const totalPages = Math.max(1, Math.ceil(total / limit))
    const safePage = Math.min(page, totalPages)
    return res.status(200).json({
      ok: true,
      transactions: transactions.slice((safePage - 1) * limit, safePage * limit),
      pagination: {
        page: safePage,
        limit,
        total,
        total_pages: totalPages,
        has_prev: safePage > 1,
        has_next: safePage < totalPages,
      },
      truncated_source_scan: orders.truncated,
    })
  } catch (error) {
    console.error('GET ADMIN AUTHOR PAGE AUTHOR TRANSACTIONS ERROR:', error)
    return res.status(error.statusCode || 500).json({
      ok: false,
      message: error.message || 'Failed to load Author Page orders',
    })
  }
}
