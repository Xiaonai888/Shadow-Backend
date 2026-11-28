import test from 'node:test'
import assert from 'node:assert/strict'
import { BOOKING_TEXT_LIMITS } from '../shadowAiPreOrderMessage.js'
import { createShadowLocalDictionary } from './shadowLocalDictionary.js'
import { createShadowLocalContextUnderstanding as create } from './shadowLocalContextUnderstanding.js'

const id = '11111111-1111-4111-8111-111111111111'
const dictionary = createShadowLocalDictionary()
const blank = Object.freeze({ intent: 'unclear', question: null, items: null, signature_requested: null, ...Object.fromEntries(Object.keys(BOOKING_TEXT_LIMITS).map(key => [key, null])) })
const expected = { ...blank, intent: 'booking', items: [{ book_id: id, edition: 'limited', quantity: 2 }] }
const input = Object.freeze({ message: 'យក Limited ២ក្បាល', current_draft: Object.freeze({ items: Object.freeze([Object.freeze({ book_id: id, edition: null, quantity: null })]) }), catalog: Object.freeze({ books: Object.freeze([Object.freeze({ id, title: 'Moon', editions: Object.freeze(['standard', 'limited']) })]), delivery_companies: [] }) })

test('old recognized output wins and there is no secondary interpretation', () => {
  let count = 0
  const run = create({ interpretReader() { count++; return expected }, interpretSelection() { assert.fail('unexpected call') } })
  assert.equal(run(input, dictionary), expected)
  assert.equal(count, 1)
})

test('fallback has one extra local function call with original context and same dictionary', () => {
  const before = JSON.stringify(input), calls = []
  const run = create({ interpretReader(value, dict) { calls.push(value); assert.equal(dict, dictionary); return blank }, interpretSelection(value, dict) { calls.push(value); assert.equal(dict, dictionary); assert.equal(value.current_draft, input.current_draft); assert.equal(value.catalog, input.catalog); assert.equal(value.message, 'edition: limited\nquantity: 2'); return expected } })
  assert.equal(run(input, dictionary), expected)
  assert.equal(calls.length, 2)
  assert.equal(JSON.stringify(input), before)
})

test('unknown and unsupported text executes the original interpreter only', () => {
  let count = 0
  const run = create({ interpretReader() { count++; return blank } })
  assert.equal(run({ ...input, message: 'yes' }, dictionary), blank)
  assert.equal(count, 1)
})

test('secondary output must match expected complete schema with no extra fields', () => {
  const { name, ...incomplete } = expected
  for (const output of [null, blank, incomplete, { ...expected, question: 'price' }, { ...expected, name: 'Unexpected' }, { ...expected, signature_requested: false }, { ...expected, payment: true }, { ...expected, items: [{ ...expected.items[0], quantity: 3 }] }, { ...expected, items: [{ ...expected.items[0], extra: true }] }, { ...expected, items: [expected.items[0], expected.items[0]] }]) {
    const run = create({ interpretReader: () => blank, interpretSelection: () => output })
    assert.equal(run(input, dictionary), blank)
  }
})

test('fallback propagates interpreter failures without repeated calls', () => {
  let count = 0
  const run = create({ interpretReader: () => blank, interpretSelection() { count++; throw Error('failure') } })
  assert.throws(() => run(input, dictionary), /failure/)
  assert.equal(count, 1)
})

test('invalid dependencies fail during initialization', () => {
  assert.throws(() => create(), TypeError)
  assert.throws(() => create({ interpretReader() {}, interpretSelection: 42 }), TypeError)
})
