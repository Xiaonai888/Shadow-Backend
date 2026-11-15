import {
  mapAdminFinancialPayment,
  mapAdminFinancialBinanceTopup,
  mapAdminFinancialEarning,
  mapAdminFinancialAuthorStoreOrder,
} from './adminFinancialReportsMapping.service.js'

const PAGE_SIZE = 200
const MAX_SOURCE_ROWS = 10000
const MAX_PERIOD_DAYS = 93

const SOURCE_TABLES = [
  {
    key: 'aba_topups',
    table: 'payment_transactions',
    fields: 'id,user_id,order_id,tran_id,status,purchase_type,package_usd,amount_usd,diamonds,bonus_gems,payment_method,created_at,updated_at,paid_at,confirmed_at,released_at',
  },
  {
    key: 'binance_topups',
    table: 'binance_checkout_orders',
    fields: 'id,user_id,package_usd,diamonds,amount_usdt,status,created_at,updated_at,credited_at',
  },
  {
    key: 'earnings',
    table: 'author_earnings',
    fields: 'id,author_id,author_user_id,story_id,episode_id,unlock_transaction_id,source_type,currency,paid_diamonds,original_diamonds,net_paid_diamonds,discount_percent,share_source,author_share_percent,author_earned_diamonds,platform_earned_diamonds,diamond_to_usd_rate,earning_status,metadata,created_at',
  },
  {
    key: 'author_store',
    table: 'author_store_orders',
    fields: 'id,author_page_id,created_at,updated_at,paid_at,payment_status,status,product_subtotal_usd,platform_fee_usd,author_income_usd,delivery_fee_usd,total_usd,request_payload,items:author_store_order_items(*)',
  },
]

function iso(value, label) {
  const date = new Date(value)
  if (!value || Number.isNaN(date.getTime())) throw new Error(`Invalid ${label}`)
  return date.toISOString()
}

function monthWindow(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) {
    throw new Error('Month must use YYYY-MM format')
  }
  const [year, number] = month.split('-').map(Number)
  const start = new Date(Date.UTC(year, number - 1, 1, -7))
  const end = new Date(Date.UTC(year, number, 1, -7))
  return { from: start.toISOString(), to: end.toISOString() }
}

async function pageTable(db, config, from, to) {
  const rows = []
  for (let offset = 0; offset < MAX_SOURCE_ROWS; offset += PAGE_SIZE) {
    let query = db.from(config.table)
      .select(config.fields)
      .gte('created_at', from)
      .lt('created_at', to)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
    if (config.key === 'earnings') {
      query = query.eq('currency', 'diamond').in('source_type', ['diamond_unlock', 'diamond_gift'])
    }
    const { data, error } = await query.range(offset, offset + PAGE_SIZE - 1)
    if (error) throw new Error(`Financial ${config.key}: ${error.message || 'Query failed'}`)
    if (!Array.isArray(data)) throw new Error(`Financial ${config.key}: Invalid query response`)
    rows.push(...data)
    if (data.length < PAGE_SIZE) return rows
  }
  throw new Error(`Financial ${config.key}: source exceeded ${MAX_SOURCE_ROWS} rows; use a smaller date window`)
}

function unique(list) {
  return [...new Set(list.map((v) => String(v || '').trim()).filter(Boolean))]
}

async function byId(db, table, fields, ids) {
  const map = new Map()
  for (let offset = 0; offset < ids.length; offset += PAGE_SIZE) {
    const chunk = ids.slice(offset, offset + PAGE_SIZE)
    const { data, error } = await db.from(table).select(fields).in('id', chunk)
    if (error) throw new Error(`Financial ${table}: ${error.message || 'Lookup failed'}`)
    for (const row of data || []) map.set(String(row.id), row)
  }
  return map
}

export function getAdminFinancialMonthWindow(month) {
  return monthWindow(month)
}

export async function loadAdminFinancialReportSourceRows({ db, month, from, to } = {}) {
  if (!db || typeof db.from !== 'function') throw new Error('Supabase client is required')
  const period = month ? monthWindow(month) : { from: iso(from, 'from'), to: iso(to, 'to') }
  const start = new Date(period.from).getTime()
  const end = new Date(period.to).getTime()
  if (start >= end || end - start > MAX_PERIOD_DAYS * 86400000) {
    throw new Error(`Financial source range must be 1 to ${MAX_PERIOD_DAYS} days`)
  }

  const [payments, binance, earnings, storeOrders] = await Promise.all(
    SOURCE_TABLES.map((source) => pageTable(db, source, period.from, period.to))
  )

  const userIds = unique([
    ...payments.map((row) => row.user_id),
    ...binance.map((row) => row.user_id),
  ])
  const authorIds = unique([
    ...earnings.map((row) => row.author_id),
    ...storeOrders.map((row) => row.author_page_id),
  ])
  const storyIds = unique(earnings.map((row) => row.story_id))
  const productIds = unique(storeOrders.flatMap((order) =>
    (Array.isArray(order.items) ? order.items : []).map((item) => item.product_id)
  ))
  const [users, authors, stories, products] = await Promise.all([
    byId(db, 'users', 'id,name,username', userIds),
    byId(db, 'author_pages', 'id,page_name', authorIds),
    byId(db, 'stories', 'id,title', storyIds),
    byId(db, 'author_store_products', 'id,title,product_type', productIds),
  ])
  const context = { users, authors, stories, products }
  const entries = [
    ...payments.map((row) => mapAdminFinancialPayment(row, context)),
    ...binance.map((row) => mapAdminFinancialBinanceTopup(row, context)),
    ...earnings.map((row) => mapAdminFinancialEarning(row, context)),
    ...storeOrders.flatMap((row) => mapAdminFinancialAuthorStoreOrder(row, context)),
  ].filter(Boolean)
  const rows = new Map()
  for (const row of entries) {
    if (rows.has(row.transaction_key)) throw new Error(`Duplicate financial transaction: ${row.transaction_key}`)
    rows.set(row.transaction_key, row)
  }
  return {
    range: period,
    rows: [...rows.values()].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.transaction_key.localeCompare(b.transaction_key)),
    source_counts: {
      aba_topups: payments.length,
      binance_topups: binance.length,
      earnings: earnings.length,
      author_store_orders: storeOrders.length,
    },
  }
}
