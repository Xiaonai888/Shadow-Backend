import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mapAdminFinancialPayment,
  mapAdminFinancialBinanceTopup,
  mapAdminFinancialEarning,
  mapAdminFinancialAuthorStoreOrder,
} from '../services/adminFinancialReportsMapping.service.js'
import {
  getAdminFinancialMonthWindow,
  loadAdminFinancialReportSourceRows,
} from '../services/adminFinancialReportsSources.service.js'

const created_at = '2026-11-15T01:00:00.000Z'

test('ABA diamond payment counts only confirmed cash, not premium', () => {
  const base = { id: 'p-1', status: 'success', purchase_type: 'diamonds', amount_usd: 12, created_at }
  const row = mapAdminFinancialPayment(base)
  assert.equal(row.transaction_key, 'aba-topup:p-1')
  assert.equal(row.cash_received_usd, 12)
  assert.equal(row.platform_earn_usd, 0)
  assert.equal(row.topup_cash_usd, 12)
  assert.equal(mapAdminFinancialPayment({ ...base, purchase_type: 'premium' }), null)
  assert.equal(mapAdminFinancialPayment({ ...base, status: 'waiting_payment' }), null)
  assert.equal(mapAdminFinancialPayment({ ...base, status: 'refunded' }).cash_refunded_usd, 12)
})

test('Binance top-up only counts credited orders and excludes USDT fee', () => {
  const base = { id: 'b-1', package_usd: 10, amount_usdt: 11, credited_at: created_at, created_at, status: 'credited' }
  const row = mapAdminFinancialBinanceTopup(base)
  assert.equal(row.cash_received_usd, 10)
  assert.equal(row.revenue_type, 'diamond_topup')
  assert.equal(row.platform_earn_usd, 0)
  assert.equal(mapAdminFinancialBinanceTopup({ ...base, credited_at: null }), null)
})

test('episode income splits diamonds without double-counting cash', () => {
  const row = mapAdminFinancialEarning({
    id: 'e-1', source_type: 'diamond_unlock', earning_status: 'available', created_at,
    story_id: 's-1', author_id: 'a-1', paid_diamonds: 10, original_diamonds: 12,
    net_paid_diamonds: 9, author_earned_diamonds: 7, platform_earned_diamonds: 2,
    diamond_to_usd_rate: 0.01, author_share_percent: 77.7778,
    metadata: { story_title: 'Novel A' },
  }, { authors: new Map([['a-1', { page_name: 'Author A' }]]) })
  assert.equal(row.item_title, 'Novel A')
  assert.equal(row.author_name, 'Author A')
  assert.equal(row.cash_received_usd, 0)
  assert.equal(row.product_sales_usd, 0.1)
  assert.equal(row.author_earn_usd, 0.07)
  assert.equal(row.platform_earn_usd, 0.02)
  assert.equal(row.distributable_usd, 0.09)
  assert.equal(row.discount_usd, 0.02)
})

test('void earnings reverse previous value rather than disappearing', () => {
  const earning = {
    id: 'e-2', source_type: 'diamond_gift', created_at, earning_status: 'paid',
    paid_diamonds: 100, net_paid_diamonds: 100,
    author_earned_diamonds: 100, platform_earned_diamonds: 0,
    diamond_to_usd_rate: 0.01,
  }
  const active = mapAdminFinancialEarning(earning)
  const reversed = mapAdminFinancialEarning({ ...earning, earning_status: 'void' })
  assert.equal(active.author_earn_usd, 1)
  assert.equal(reversed.transaction_key, active.transaction_key)
  assert.equal(reversed.author_earn_usd, 0)
  assert.equal(reversed.spent_diamonds, 0)
})

test('mixed PDF and Book order has one cash entry and one shipping entry', () => {
  const order = {
    id: 'order-1', payment_status: 'paid', created_at,
    product_subtotal_usd: 14, platform_fee_usd: 1.4,
    author_income_usd: 12.6, delivery_fee_usd: 2, total_usd: 16,
    items: [
      { id: 'item-pdf', product_id: 'product-pdf', product_title: 'Novel PDF', total_price: 4 },
      { id: 'item-book', product_id: 'product-book', product_title: 'Novel Book', total_price: 10 },
    ],
  }
  const context = { products: new Map([
    ['product-pdf', { title: 'Novel PDF', product_type: 'pdf' }],
    ['product-book', { title: 'Novel Book', product_type: 'book' }],
  ]) }
  const rows = mapAdminFinancialAuthorStoreOrder(order, context)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].revenue_type, 'pdf_sale')
  assert.equal(rows[1].revenue_type, 'book_sale')
  assert.equal(rows[0].shipping_fee_usd, 0)
  assert.equal(rows[1].shipping_fee_usd, 2)
  assert.equal(rows.reduce((sum, row) => sum + row.cash_received_usd, 0), 16)
  assert.equal(rows.reduce((sum, row) => sum + row.author_earn_usd, 0), 12.6)
  assert.equal(rows.reduce((sum, row) => sum + row.platform_earn_usd, 0), 1.4)
})

test('refunded Author Store order retains cash receipt with matching refund and zero sales', () => {
  const order = {
    id: 'order-2', payment_status: 'refunded', created_at,
    product_subtotal_usd: 9, total_usd: 9,
    items: [{ id: 'item-2', product_type: 'pdf', total_price: 9, product_title: 'Refunded PDF' }],
  }
  const row = mapAdminFinancialAuthorStoreOrder(order)[0]
  assert.equal(row.cash_received_usd, 9)
  assert.equal(row.cash_refunded_usd, 9)
  assert.equal(row.author_earn_usd, 0)
  assert.equal(row.product_sales_usd, 0)
})

test('financial source mapping fails closed on unknown product type', () => {
  assert.throws(() => mapAdminFinancialAuthorStoreOrder({
    id: 'order-3', payment_status: 'paid', created_at,
    items: [{ id: 'item-3', total_price: 3 }],
  }), /Unknown product type/)
})

test('Cambodia month window uses UTC+7 boundaries', () => {
  const range = getAdminFinancialMonthWindow('2026-11')
  assert.equal(range.from, '2026-10-31T17:00:00.000Z')
  assert.equal(range.to, '2026-11-30T17:00:00.000Z')
  assert.throws(() => getAdminFinancialMonthWindow('2026-13'), /Month/)
})

function mockDb(tableData) {
  return {
    from(table) {
      let rows = tableData[table] || []
      const request = {
        select() { return this },
        gte(field, value) { rows = rows.filter((row) => String(row[field]) >= value); return this },
        lt(field, value) { rows = rows.filter((row) => String(row[field]) < value); return this },
        order() { return this },
        eq(field, value) { rows = rows.filter((row) => row[field] === value); return this },
        in(field, values) { rows = rows.filter((row) => values.includes(row[field])); return this },
        async range(start, end) { return { data: rows.slice(start, end + 1), error: null } },
        then(resolve, reject) { return Promise.resolve({ data: rows, error: null }).then(resolve, reject) },
      }
      return request
    },
  }
}

test('source loader maps real table shapes without a live network or cron', async () => {
  const db = mockDb({
    payment_transactions: [{ id: 'p', user_id: 'u', status: 'success', purchase_type: 'diamonds', amount_usd: 5, created_at }],
    binance_checkout_orders: [],
    author_earnings: [{ id: 'e', source_type: 'diamond_gift', currency: 'diamond', created_at, paid_diamonds: 10, net_paid_diamonds: 10, author_earned_diamonds: 10, diamond_to_usd_rate: 0.01 }],
    author_store_orders: [],
    users: [{ id: 'u', name: 'Reader' }],
  })
  const result = await loadAdminFinancialReportSourceRows({ db, month: '2026-11' })
  assert.equal(result.rows.length, 2)
  assert.equal(result.rows[0].cash_received_usd, 5)
  assert.equal(result.rows[1].cash_received_usd, 0)
  assert.equal(result.source_counts.aba_topups, 1)
})
