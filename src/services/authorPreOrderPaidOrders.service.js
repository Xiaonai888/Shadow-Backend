import { supabase } from '../config/supabase.js'
import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'
import {
  parsePreOrderReportFilters,
  PRE_ORDER_REPORT_MAX_EXPORT_ORDERS,
  PRE_ORDER_REPORT_EXPORT_PAGE_SIZE,
} from './authorPreOrderReportFilters.service.js'

const ORDER_COLUMNS = [
  'id', 'campaign_id', 'buyer_user_id', 'paid_at', 'created_at',
  'payment_reference', 'payment_status', 'fulfillment_status',
  'buyer_snapshot', 'delivery_snapshot', 'signature_requested',
  'signature_name', 'buyer_note', 'subtotal_usd', 'signature_fee_usd',
  'delivery_fee_usd', 'total_usd',
  'items:author_preorder_order_items(id,book_id,edition,quantity,unit_price_usd,book_title_snapshot)',
].join(',')

function rejectDatabase(error) {
  if (!error) return
  if (['42P01', '42703', 'PGRST200', 'PGRST202'].includes(error.code)) {
    throw preOrderError('PRE_ORDER_REPORT_NOT_READY', 'Pre-order reports are not ready until the database is installed', 503)
  }
  console.error('AUTHOR_PRE_ORDER_REPORT_DB:', String(error.message || error))
  throw preOrderError('PRE_ORDER_REPORT_STORAGE_FAILED', 'Could not load pre-order paid orders', 503)
}

async function requireSelection(owner, filters) {
  let campaignId = filters.campaignId
  let book = null
  if (filters.bookId) {
    const { data, error } = await supabase.from('author_preorder_books')
      .select('id,campaign_id,title')
      .eq('id', preOrderUuid(filters.bookId, 'book ID'))
      .maybeSingle()
    rejectDatabase(error)
    if (!data || (campaignId && data.campaign_id !== campaignId)) {
      throw preOrderError('PRE_ORDER_REPORT_BOOK_NOT_FOUND', 'Book record was not found', 404)
    }
    book = data
    campaignId = data.campaign_id
  }
  let campaign = null
  if (campaignId) {
    const { data, error } = await supabase.from('author_preorder_campaigns')
      .select('id,title,author_page_id,owner_user_id')
      .eq('id', campaignId)
      .eq('author_page_id', owner.authorPageId)
      .eq('owner_user_id', owner.userId)
      .maybeSingle()
    rejectDatabase(error)
    if (!data) throw preOrderError('PRE_ORDER_REPORT_CAMPAIGN_NOT_FOUND', 'Pre-order record was not found', 404)
    campaign = data
  }
  return { ...filters, campaignId, campaign, book }
}

function orderQuery(owner, selection) {
  const needsMatch = Boolean(selection.bookId || selection.edition !== 'all')
  const columns = needsMatch
    ? `${ORDER_COLUMNS},matches:author_preorder_order_items!inner(id,book_id,edition)`
    : ORDER_COLUMNS
  let query = supabase.from('author_preorder_orders')
    .select(columns, { count: 'exact' })
    .eq('author_page_id', owner.authorPageId)
    .eq('payment_status', 'paid')
    .not('paid_at', 'is', null)
  if (selection.campaignId) query = query.eq('campaign_id', selection.campaignId)
  if (selection.bookId) query = query.eq('matches.book_id', selection.bookId)
  if (selection.edition !== 'all') query = query.eq('matches.edition', selection.edition)
  if (selection.fromAt) query = query.gte('paid_at', selection.fromAt)
  if (selection.toExclusive) query = query.lt('paid_at', selection.toExclusive)
  if (selection.sort === 'highest') {
    query = query.order('total_usd', { ascending: false }).order('id', { ascending: true })
  } else {
    const ascending = selection.sort === 'oldest'
    query = query.order('paid_at', { ascending }).order('id', { ascending })
  }
  return query
}

function valueText(value, max = 1000) {
  return String(value ?? '').slice(0, max)
}

function money(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) / 100 : 0
}

function normalizeOrder(order, selection) {
  const buyer = order.buyer_snapshot && typeof order.buyer_snapshot === 'object' ? order.buyer_snapshot : {}
  const delivery = order.delivery_snapshot && typeof order.delivery_snapshot === 'object' ? order.delivery_snapshot : {}
  const company = delivery.company && typeof delivery.company === 'object'
    ? delivery.company
    : delivery.delivery_company && typeof delivery.delivery_company === 'object'
      ? delivery.delivery_company
      : delivery
  const allItems = Array.isArray(order.items) ? order.items : []
  const selectedItems = allItems.filter(item =>
    (!selection.bookId || item.book_id === selection.bookId) &&
    (selection.edition === 'all' || item.edition === selection.edition)
  )
  const items = selectedItems.map(item => {
    const quantity = Math.max(0, Number(item.quantity || 0))
    const unit = money(item.unit_price_usd)
    return {
      id: item.id,
      book_id: item.book_id,
      title: valueText(item.book_title_snapshot, 180),
      edition: item.edition,
      quantity,
      unit_price_usd: unit,
      line_total_usd: Math.round(unit * quantity * 100) / 100,
    }
  })
  return {
    id: order.id,
    campaign_id: order.campaign_id,
    buyer_user_id: order.buyer_user_id,
    paid_at: order.paid_at,
    created_at: order.created_at,
    payment_reference: valueText(order.payment_reference, 120),
    payment_status: order.payment_status,
    fulfillment_status: order.fulfillment_status,
    buyer_name: valueText(buyer.name || buyer.buyer_name, 160),
    buyer_phone: valueText(buyer.phone_number || buyer.phone || buyer.buyer_phone, 60),
    buyer_telegram: valueText(buyer.telegram_username || buyer.telegram, 250),
    buyer_facebook: valueText(buyer.facebook_link || buyer.facebook_url, 500),
    delivery_address: valueText(buyer.delivery_address || delivery.address || delivery.delivery_address, 800),
    delivery_company: valueText(company.company_name || company.name || company.label || company.shortName || company.short_name, 160),
    delivery_company_key: valueText(company.company_key || company.key || company.id, 80),
    delivery_fee_usd: money(order.delivery_fee_usd),
    signature_requested: order.signature_requested === true,
    signature_name: valueText(order.signature_name, 160),
    signature_fee_usd: money(order.signature_fee_usd),
    buyer_note: valueText(order.buyer_note, 1000),
    subtotal_usd: money(order.subtotal_usd),
    total_usd: money(order.total_usd),
    selected_items_subtotal_usd: Math.round(items.reduce((total, item) => total + item.line_total_usd, 0) * 100) / 100,
    standard_units: items.filter(item => item.edition === 'standard').reduce((total, item) => total + item.quantity, 0),
    limited_units: items.filter(item => item.edition === 'limited').reduce((total, item) => total + item.quantity, 0),
    items,
  }
}

async function readPage(owner, selection, offset, limit) {
  const { data, error, count } = await orderQuery(owner, selection).range(offset, offset + limit - 1)
  rejectDatabase(error)
  return { rows: (data || []).map(row => normalizeOrder(row, selection)), total: Number(count || 0) }
}

export async function listPaidAuthorPreOrderOrders(owner, rawFilters) {
  const filters = parsePreOrderReportFilters(rawFilters)
  const selection = await requireSelection(owner, filters)
  const offset = (filters.page - 1) * filters.limit
  const result = await readPage(owner, selection, offset, filters.limit)
  return {
    orders: result.rows,
    total_paid_orders: result.total,
    page: filters.page,
    limit: filters.limit,
    has_more: offset + result.rows.length < result.total,
    summary_page: {
      standard_units: result.rows.reduce((total, row) => total + row.standard_units, 0),
      limited_units: result.rows.reduce((total, row) => total + row.limited_units, 0),
    },
    filters: { campaign_id: selection.campaignId, book_id: selection.bookId, edition: selection.edition },
  }
}

export async function exportPaidAuthorPreOrderOrders(owner, rawFilters) {
  const selection = await requireSelection(owner, parsePreOrderReportFilters(rawFilters, { exportAll: true }))
  const allOrders = []
  let total = 0
  for (let offset = 0; offset <= PRE_ORDER_REPORT_MAX_EXPORT_ORDERS; offset += PRE_ORDER_REPORT_EXPORT_PAGE_SIZE) {
    const result = await readPage(owner, selection, offset, PRE_ORDER_REPORT_EXPORT_PAGE_SIZE)
    if (offset === 0) {
      total = result.total
      if (total > PRE_ORDER_REPORT_MAX_EXPORT_ORDERS) {
        throw preOrderError('PRE_ORDER_REPORT_EXPORT_TOO_LARGE', 'Choose a shorter date range to export at most 20,000 paid orders', 413)
      }
    }
    allOrders.push(...result.rows)
    if (allOrders.length >= total || result.rows.length === 0) break
  }
  if (allOrders.length !== total) {
    throw preOrderError('PRE_ORDER_REPORT_EXPORT_CHANGED', 'Orders changed during export; please retry', 409)
  }
  const fees = new Map()
  for (let index = 0; index < allOrders.length; index += 300) {
    const ids = allOrders.slice(index, index + 300).map(order => order.id)
    if (!ids.length) break
    const { data, error } = await supabase.from('author_preorder_fee_ledger')
      .select('order_id,service_fee_usd')
      .eq('author_page_id', owner.authorPageId)
      .in('order_id', ids)
    rejectDatabase(error)
    for (const row of data || []) fees.set(row.order_id, Number(row.service_fee_usd || 0))
  }
  return {
    orders: allOrders,
    fees,
    scope: {
      campaign_id: selection.campaignId || '',
      campaign_title: selection.campaign?.title || '',
      book_id: selection.bookId || '',
      book_title: selection.book?.title || '',
      edition: selection.edition,
    },
  }
}
