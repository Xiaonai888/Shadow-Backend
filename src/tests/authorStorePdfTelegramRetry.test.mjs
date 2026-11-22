import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../services/telegramMissingReportRecovery.service.js', import.meta.url), 'utf8')
  .replace(/^import .*\n/gm, '')
  .replaceAll('export ', '') + '\nthis.api = { recoverMissingTelegramReports, startTelegramMissingReportRecovery };'

const copy = value => JSON.parse(JSON.stringify(value))
const subset = (actual, expected) => expected && typeof expected === 'object' && !Array.isArray(expected)
  ? Object.entries(expected).every(([key, value]) => subset(actual?.[key], value)) : actual === expected

async function run({
  admin = 'sent', author = 'sent', adminError = 'fetch failed', authorError = 'fetch failed',
  mainBot = true, authorBot = true, adminChat = true, authorChat = true,
  stale = false, sendError = null,
} = {}) {
  const ago = new Date(Date.now() - 3600000).toISOString()
  const record = {
    id: 'database-order-id', order_id: 'AMWQMAM75A7BD6EAC', order_number: 'AMWQMAM75A7BD6EAC',
    author_page_id: 'author-page-id', buyer_id: 'reader-id',
    buyer_profile: { name: 'Reader' }, total_usd: 1.25, author_income_usd: 1.125,
    payment_status: 'paid', pdf_unlock_status: 'unlocked', status: 'confirmed',
    created_at: ago, updated_at: ago,
    items: [{ product_type: 'pdf', product_title: 'Example', quantity: 1 }],
    request_payload: { pdf_telegram_reports: {
      admin: { status: admin, error: adminError },
      author: { status: author, error: authorError }, attempted_at: ago,
    } },
  }
  const sent = []
  const logs = []
  const updates = []

  class Query {
    constructor(table) { this.table = table; this.filters = []; this.patch = null }
    select() { return this }
    update(patch) { this.patch = patch; return this }
    eq(field, value) { this.filters.push(item => item[field] === value); return this }
    gte(field, value) { this.filters.push(item => item[field] >= value); return this }
    contains(field, value) { this.filters.push(item => subset(item[field], value)); return this }
    not() { return this }
    is() { return this }
    in() { return this }
    order() { return this }
    limit() { return this }
    result(single = false) {
      if (this.table === 'telegram_payments') return { data: single ? null : [], error: null }
      if (this.table === 'author_pages') return {
        data: { page_name: 'Author', page_username: 'author', telegram_chat_id: authorChat ? 'author-chat' : null },
        error: null,
      }
      if (this.table !== 'author_store_orders') throw new Error(`Unexpected ${this.table}`)
      if (!this.filters.every(fn => fn(record))) return { data: single ? null : [], error: null }
      if (this.patch) {
        if (stale) return { data: single ? null : [], error: null }
        Object.assign(record, copy(this.patch))
        updates.push(copy(this.patch))
      }
      return { data: single ? copy(record) : [copy(record)], error: null }
    }
    maybeSingle() { return Promise.resolve(this.result(true)) }
    then(resolve, reject) { return Promise.resolve(this.result()).then(resolve, reject) }
  }
  const send = async (target) => {
    sent.push(target)
    if (sendError) throw new Error(sendError)
    return { ok: true, result: { message_id: target === 'admin' ? 101 : 102 } }
  }
  const env = {
    ...(mainBot ? { TELEGRAM_BOT_TOKEN: 'test-main' } : {}),
    ...(authorBot ? { TELEGRAM_AUTHOR_STORE_BOT_TOKEN: 'test-author' } : {}),
    ...(adminChat ? { TELEGRAM_AUTHOR_STORE_ADMIN_CHAT_ID: 'admin-chat' } : {}),
  }
  const context = {
    supabase: { from: table => new Query(table) },
    replyTelegram: () => Promise.resolve({ ok: true, result: { message_id: 5 } }),
    sendTelegramMessage: () => send('admin'),
    sendAuthorStoreTelegramMessage: () => send('author'),
    html: value => String(value || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;'),
    buildAuthorStoreAttributionReportLines: () => [],
    console: { info: (...values) => logs.push(['info', ...values]), warn: (...values) => logs.push(['warn', ...values]), error: (...values) => logs.push(['error', ...values]) },
    process: { env },
    setInterval: () => ({ unref() {} }),
    Date, Map, Set, Promise,
  }
  vm.runInNewContext(source, context, { timeout: 2000 })
  await context.api.recoverMissingTelegramReports()
  return { record, sent, updates, logs }
}

test('uncertain admin network result requires manual review, not an unsafe automatic resend', async () => {
  const result = await run({ admin: 'failed' })
  assert.deepEqual(result.sent, [])
  assert.equal(result.record.request_payload.pdf_telegram_reports.admin.status, 'review_required')
  assert.equal(result.record.request_payload.pdf_telegram_reports.author.status, 'sent')
})

test('two uncertain recipients are flagged together without duplicating either report', async () => {
  const result = await run({ admin: 'failed', author: 'failed' })
  assert.deepEqual(result.sent, [])
  assert.equal(result.record.request_payload.pdf_telegram_reports.admin.status, 'review_required')
  assert.equal(result.record.request_payload.pdf_telegram_reports.author.status, 'review_required')
  assert.equal(result.updates.length, 1)
})

test('author-only bot can recover a known Telegram HTTP error independently', async () => {
  const result = await run({ mainBot: false, author: 'failed', authorError: 'Telegram HTTP 429' })
  assert.deepEqual(result.sent, ['author'])
  assert.equal(result.record.request_payload.pdf_telegram_reports.author.status, 'sent')
  assert.equal(result.record.telegram_status, 'sent')
})

test('known retry error for author works while admin bot is unavailable', async () => {
  const result = await run({ mainBot: false, admin: 'failed', adminError: 'Telegram HTTP 429', author: 'failed', authorError: 'Telegram HTTP 429' })
  assert.deepEqual(result.sent, ['author'])
  assert.equal(result.record.request_payload.pdf_telegram_reports.admin.status, 'failed')
  assert.equal(result.record.request_payload.pdf_telegram_reports.author.status, 'sent')
})

test('a stale database claim does not send any Telegram message', async () => {
  const result = await run({ admin: 'failed', stale: true })
  assert.deepEqual(result.sent, [])
  assert.equal(result.record.request_payload.pdf_telegram_reports.admin.status, 'failed')
})

test('uncertain failure after a Telegram API attempt is never retried automatically', async () => {
  const result = await run({ admin: 'failed', adminError: 'Telegram HTTP 429', sendError: 'fetch failed' })
  assert.deepEqual(result.sent, ['admin'])
  assert.equal(result.record.request_payload.pdf_telegram_reports.admin.status, 'review_required')
  assert.equal(result.record.request_payload.pdf_telegram_reports.admin.retry_attempts, 1)
})

test('no configured bot never sends a report', async () => {
  const result = await run({ admin: 'failed', mainBot: false, authorBot: false })
  assert.deepEqual(result.sent, [])
  assert.equal(result.record.request_payload.pdf_telegram_reports.admin.status, 'failed')
})
