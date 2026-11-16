import test from 'node:test'
import assert from 'node:assert/strict'
import { getAdminFinancialHistoryRange } from '../services/adminFinancialReportsHistory.service.js'

function fakeDatabase(values, errors = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      calls.push(table)
      const query = {
        select() { return this },
        order() { return this },
        limit() { return this },
        eq() { return this },
        in() { return this },
        then(resolve) {
          return Promise.resolve(errors[table]
            ? { data: null, error: { message: errors[table] } }
            : { data: values[table] ? [{ created_at: values[table] }] : [], error: null }).then(resolve)
        },
      }
      return query
    },
  }
}

const now = new Date('2026-11-16T00:00:00Z')

test('finds earliest income from all four source tables', async () => {
  const db = fakeDatabase({
    payment_transactions: '2026-08-11T00:00:00Z',
    binance_checkout_orders: '2026-10-01T00:00:00Z',
    author_earnings: '2026-05-30T10:00:00Z',
    author_store_orders: '2026-09-12T00:00:00Z',
  })
  const history = await getAdminFinancialHistoryRange(db, { now })
  assert.equal(history.start_month, '2026-05')
  assert.equal(history.end_month, '2026-11')
  assert.equal(history.months_total, 7)
  assert.equal(history.has_transactions, true)
  assert.equal(db.calls.length, 4)
})

test('uses Cambodia local month at the UTC month boundary', async () => {
  const db = fakeDatabase({ payment_transactions: '2026-05-31T19:00:00Z' })
  const history = await getAdminFinancialHistoryRange(db, { now })
  assert.equal(history.start_month, '2026-06')
  assert.equal(history.months_total, 6)
})

test('empty financial history reports current month without inventing old transactions', async () => {
  const history = await getAdminFinancialHistoryRange(fakeDatabase({}), { now })
  assert.equal(history.start_month, '2026-11')
  assert.equal(history.months_total, 1)
  assert.equal(history.has_transactions, false)
})

test('returns source-specific failure instead of silently dropping history', async () => {
  await assert.rejects(
    getAdminFinancialHistoryRange(fakeDatabase({}, { author_earnings: 'permission denied' }), { now }),
    /Episode \/ Gift earnings: permission denied/
  )
})

test('rejects missing database client', async () => {
  await assert.rejects(getAdminFinancialHistoryRange(null, { now }), /Supabase client is required/)
})
