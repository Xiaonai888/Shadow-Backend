import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeAdminFinancialTransaction,
  normalizeAdminFinancialBatch,
} from '../services/adminFinancialReportsTransactions.service.js'

const base = {
  transaction_key: 'test:001',
  occurred_at: '2026-11-14T10:00:00+07:00',
  updated_at: '2026-11-14T11:00:00+07:00',
}

test('diamond top-up records cash without platform earnings', () => {
  const row = normalizeAdminFinancialTransaction({
    ...base,
    revenue_type: 'diamond_topup',
    cash_received_usd: 10,
  })
  assert.equal(row.cash_received_usd, 10)
  assert.equal(row.topup_cash_usd, 10)
  assert.equal(row.platform_earn_usd, 0)
  assert.equal(row.occurred_at, '2026-11-14T03:00:00.000Z')
})

test('episode unlock uses diamonds without reporting new cash', () => {
  const row = normalizeAdminFinancialTransaction({
    ...base,
    revenue_type: 'episode_unlock',
    spent_diamonds: 10,
    product_sales_usd: 0.1,
    author_earn_usd: 0.08,
    platform_earn_usd: 0.02,
    diamond_to_usd_rate: 0.01,
  })
  assert.equal(row.cash_received_usd, 0)
  assert.equal(row.platform_earn_usd, 0.02)
})

test('diamond top-up cannot be counted as platform earnings', () => {
  assert.throws(() => normalizeAdminFinancialTransaction({
    ...base,
    revenue_type: 'diamond_topup',
    cash_received_usd: 10,
    platform_earn_usd: 10,
  }), /cannot create earnings/)
})

test('diamond gift cannot be counted again as cash received', () => {
  assert.throws(() => normalizeAdminFinancialTransaction({
    ...base,
    revenue_type: 'diamond_gift',
    cash_received_usd: 1,
  }), /not new cash/)
})

test('shipping is limited to physical books', () => {
  assert.throws(() => normalizeAdminFinancialTransaction({
    ...base,
    revenue_type: 'pdf_sale',
    shipping_fee_usd: 2,
  }), /Shipping is supported/)
  assert.equal(normalizeAdminFinancialTransaction({
    ...base,
    revenue_type: 'book_sale',
    shipping_fee_usd: 2,
  }).shipping_fee_usd, 2)
})

test('rejects duplicate rows, invalid dates and unsupported revenue', () => {
  const row = { ...base, revenue_type: 'diamond_gift' }
  assert.throws(() => normalizeAdminFinancialBatch([row, row]), /Duplicate/)
  assert.throws(() => normalizeAdminFinancialTransaction({
    ...row,
    occurred_at: 'invalid',
  }), /Invalid occurred_at/)
  assert.throws(() => normalizeAdminFinancialTransaction({
    ...row,
    revenue_type: 'shadow_mall',
  }), /Unsupported revenue type/)
})
