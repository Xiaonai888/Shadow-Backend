import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../middleware/authorStorePdfCheckoutGuard.middleware.js', import.meta.url), 'utf8')
  .replace(/import\s*\{[^}]*\}\s*from\s*'[^']+'\s*/g, '')
  .replace('export async function', 'async function')
  + '\nthis.run = requireUnpurchasedAuthorStorePdf;'

async function invoke({ items = [{ id: 'pdf-1' }], user = { id: 'reader-1' }, result = [], lookupError } = {}) {
  const calls = []
  const response = {
    set(name, value) { calls.push(['set', name, value]); return response },
    status(value) { calls.push(['status', value]); return response },
    json(value) { calls.push(['json', value]); return response },
  }
  const context = {
    getAuthorStorePdfOwnership: async () => {
      if (lookupError) throw lookupError
      return result
    },
    authorStorePdfCheckoutDecision: states => {
      const restricted = states.filter(row => row.product_type === 'pdf' && row.state !== 'available')
      return restricted.length ? { ok: false, code: 'PDF_ALREADY_PURCHASED', products: restricted } : null
    },
    console: { error() {} },
  }
  vm.runInNewContext(source, context, { timeout: 2000 })
  await context.run({ user, body: { items } }, response, () => calls.push(['next']))
  return calls
}

test('already-owned PDF does not reach the payment handler', async () => {
  const calls = await invoke({ result: [{ product_type: 'pdf', state: 'purchased' }] })
  assert(calls.some(call => call[0] === 'status' && call[1] === 409))
  assert(!calls.some(call => call[0] === 'next'))
})

test('pending PDF payment does not reach checkout', async () => {
  const calls = await invoke({ result: [{ product_type: 'pdf', state: 'checking_payment' }] })
  assert(!calls.some(call => call[0] === 'next'))
})

test('unowned PDF and physical book continue to existing checkout', async () => {
  for (const state of [
    [{ product_type: 'pdf', state: 'available' }],
    [{ product_type: 'book', state: 'available' }],
  ]) {
    const calls = await invoke({ result: state })
    assert(calls.some(call => call[0] === 'next'))
  }
})

test('service outage fails closed before the payment is created', async () => {
  const calls = await invoke({ lookupError: new Error('database offline') })
  assert(calls.some(call => call[0] === 'status' && call[1] === 503))
  assert(!calls.some(call => call[0] === 'next'))
})

test('unauthenticated and malformed requests cannot create a payment', async () => {
  const bad = [
    { user: null },
    { items: [] },
    { items: Array.from({ length: 31 }, () => ({ id: 'x' })) },
    { items: [{}] },
  ]
  for (const params of bad) {
    const calls = await invoke(params)
    assert(!calls.some(call => call[0] === 'next'))
    assert(calls.some(call => call[0] === 'status'))
  }
})
