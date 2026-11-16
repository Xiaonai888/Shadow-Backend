import test from 'node:test'
import assert from 'node:assert/strict'
import { createAdminFinancialReportsHistoryHandler } from '../services/adminFinancialReportsHistoryEndpoint.service.js'

const db = { from: () => ({}) }
const now = new Date('2026-11-16T00:00:00Z')

function response() {
  return {
    code: 0,
    body: null,
    status(code) { this.code = code; return this },
    json(body) { this.body = body; return this },
  }
}

function makeHandler(loadHistory, logger = { error() {} }) {
  return createAdminFinancialReportsHistoryHandler({ db, loadHistory, clock: () => now, logger })
}

test('returns earliest month through present with one-month-per-request sync mode', async () => {
  const handler = makeHandler(async (database, options) => {
    assert.equal(database, db)
    assert.equal(options.now, now)
    return { ok: true, start_month: '2025-12', end_month: '2026-11', months_total: 12, has_transactions: true }
  })
  const res = response()
  await handler({}, res)
  assert.equal(res.code, 200)
  assert.deepEqual(res.body, {
    ok: true, start_month: '2025-12', end_month: '2026-11', months_total: 12,
    has_transactions: true, sync_mode: 'one_month_per_request',
  })
})

test('reports an empty history without inventing transactions', async () => {
  const handler = makeHandler(async () => ({ ok: true, start_month: '2026-11', end_month: '2026-11', months_total: 1, has_transactions: false }))
  const res = response()
  await handler({}, res)
  assert.equal(res.code, 200)
  assert.equal(res.body.has_transactions, false)
})

test('returns detailed source failure but hides URLs and authorization credentials', async () => {
  const logs = []
  const handler = makeHandler(async () => { throw new Error('Payment source failed at https://private.example/key Bearer secret123') }, { error: (...v) => logs.push(v) })
  const res = response()
  await handler({}, res)
  assert.equal(res.code, 502)
  assert.equal(res.body.code, 'FINANCIAL_HISTORY_RANGE_FAILED')
  assert.match(res.body.message, /Payment source failed/)
  assert.doesNotMatch(res.body.message, /private\.example|secret123/)
  assert.equal(logs.length, 1)
})

test('rejects malformed range from the source', async () => {
  const handler = makeHandler(async () => ({ ok: true, start_month: '2026-99', end_month: '2026-11', months_total: 12 }))
  const res = response()
  await handler({}, res)
  assert.equal(res.code, 502)
  assert.match(res.body.message, /Invalid financial history range/)
})

test('does not write to the database or Google Sheets', async () => {
  let calls = 0
  const handler = makeHandler(async () => { calls += 1; return { ok: true, start_month: '2026-11', end_month: '2026-11', months_total: 1 } })
  const res = response()
  await handler({}, res)
  assert.equal(calls, 1)
  assert.equal(res.code, 200)
})

test('requires a valid database and history reader', () => {
  assert.throws(() => createAdminFinancialReportsHistoryHandler({ loadHistory: async () => ({}) }), /database/)
  assert.throws(() => createAdminFinancialReportsHistoryHandler({ db }), /reader/)
})
