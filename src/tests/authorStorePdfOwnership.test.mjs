import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../services/authorStorePdfOwnership.service.js', import.meta.url), 'utf8')
  .replace("import { supabase } from '../config/supabase.js'", '')
  .replaceAll('export async function', 'async function')
  .replaceAll('export function', 'function')
  + '\nthis.api = { getAuthorStorePdfOwnership, authorStorePdfCheckoutDecision };'

const buyer = '11111111-1111-4111-8111-111111111111'
const pdf = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const book = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const orderDbId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const now = new Date().toISOString()
const oneHourAgo = new Date(Date.now() - 3600000).toISOString()
const oneHourLater = new Date(Date.now() + 3600000).toISOString()

const order = (changes = {}) => ({
  id: orderDbId, order_id: 'AMWQMAM75A7BD6EAC', buyer_id: buyer,
  status: 'waiting_payment', payment_status: 'pending', pdf_unlock_status: 'pending',
  created_at: now, expires_at: oneHourLater, request_payload: {},
  items: [{ product_id: pdf, product_type: 'pdf' }], ...changes,
})

function setup(orders = [], grants = [], products = [
  { id: pdf, product_type: 'pdf' }, { id: book, product_type: 'book' },
]) {
  const tables = {
    author_store_products: products,
    author_store_reader_downloads: grants,
    author_store_orders: orders,
  }
  const supabase = {
    from(table) {
      let data = [...tables[table]]
      const query = {
        select() { return query },
        eq(field, value) { data = data.filter(row => row[field] === value); return query },
        in(field, values) {
          data = data.filter(row => field === 'items.product_id'
            ? row.items?.some(item => values.includes(item.product_id))
            : values.includes(row[field]))
          return query
        },
        order(field, { ascending = false } = {}) {
          data.sort((a, b) => String(a[field]).localeCompare(String(b[field])) * (ascending ? 1 : -1))
          return query
        },
        limit(n) { data = data.slice(0, n); return query },
        then(resolve, reject) { return Promise.resolve({ data, error: null }).then(resolve, reject) },
      }
      return query
    },
  }
  const context = { supabase, Date, Set, Map, String, Number, Array, Error }
  vm.runInNewContext(source, context, { timeout: 2000 })
  return context.api
}

for (const [name, orders, grants, expected] of [
  ['no prior checkout', [], [], 'available'],
  ['pending payment', [order()], [], 'checking_payment'],
  ['expired unpaid payment', [order({ expires_at: oneHourAgo })], [], 'payment_recheck_required'],
  ['paid but access not granted', [order({ status: 'confirmed', payment_status: 'paid' })], [], 'access_recovery'],
  ['paid order with grant', [order({ status: 'confirmed', payment_status: 'paid', pdf_unlock_status: 'unlocked' })], [{ buyer_id: buyer, product_id: pdf, order_id: orderDbId }], 'purchased'],
  ['paid but missing linked order', [], [{ buyer_id: buyer, product_id: pdf, order_id: orderDbId }], 'access_recovery'],
]) {
  test(name, async () => {
    const api = setup(orders, grants)
    const result = await api.getAuthorStorePdfOwnership(buyer, [pdf, book])
    assert.equal(result[0].state, expected)
    assert.equal(result[1].state, 'available')
    const decision = api.authorStorePdfCheckoutDecision(result)
    assert.equal(decision === null, expected === 'available')
    if (expected !== 'available') assert.equal(decision.products.length, 1)
  })
}

test('a settled PDF order is recognized even alongside a more recent unpaid order', async () => {
  const paid = order({ status: 'confirmed', payment_status: 'paid', pdf_unlock_status: 'unlocked', created_at: oneHourAgo })
  const pending = order({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', order_id: 'AMWQMWJJ4D729DE5E', created_at: now })
  const api = setup([pending, paid], [{ buyer_id: buyer, product_id: pdf, order_id: paid.id }])
  const results = await api.getAuthorStorePdfOwnership(buyer, [pdf])
  assert.equal(results[0].state, 'purchased')
  assert.equal(results[0].order_id, paid.order_id)
})

test('invalid product identifiers and nonexistent products fail closed', async () => {
  const api = setup()
  await assert.rejects(api.getAuthorStorePdfOwnership(buyer, ['not-a-uuid']), { statusCode: 400 })
  await assert.rejects(api.getAuthorStorePdfOwnership(buyer, ['ffffffff-ffff-4fff-8fff-ffffffffffff']), { statusCode: 404 })
})
