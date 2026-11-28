import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowLocalDictionary } from './shadowLocalDictionary.js'
import { BOOKING_TEXT_LIMITS } from '../shadowAiPreOrderMessage.js'
import { resolveShadowLocalMemoryQuestion as resolve, createShadowLocalMemoryUnderstanding as create } from './shadowLocalMemoryUnderstanding.js'

const dictionary = createShadowLocalDictionary()
const blank = () => ({ intent: 'unclear', question: null, items: null, signature_requested: null, ...Object.fromEntries(Object.keys(BOOKING_TEXT_LIMITS).map(key => [key, null])) })
const question = key => ({ ...blank(), intent: 'question', question: key })
const repeat = 'please repeat the last answer'
test('explicit repeat in Khmer and English maps to previous question only', () => {
  for (const message of [repeat, 'សូមឆ្លើយសំណួរមុនម្តងទៀត។']) assert.deepEqual(resolve(message, { question: 'stock' }), { message: 'stock', question: 'stock' })
})
test('ambiguous references, mixed requests, and missing memory do not resolve', () => {
  for (const message of ['yes', 'again', 'repeat', 'repeat the last answer and book 2', 'repeat the last answer\nname: Reader']) assert.equal(resolve(message, { question: 'price' }), null)
  assert.equal(resolve(repeat, null), null); assert.equal(resolve(repeat, { question: 'constructor' }), null)
})
test('all supported remembered categories map to current dictionary', () => {
  for (const category of ['books','price','stock','delivery','signature','schedule','requirements']) assert.equal(dictionary.lookup('questions', resolve(repeat, { question: category }).message), category)
})
test('existing recognized answer wins without fallback', () => {
  let count = 0; const existing = question('delivery'); const run = create({ interpretReader() { count++; return existing } }); assert.equal(run({ message: repeat }, dictionary, { question: 'stock' }), existing); assert.equal(count, 1)
})
test('fallback invokes same interpreter once more with fresh input context', () => {
  const calls = [], input = Object.freeze({ message: repeat, catalog: Object.freeze({}), current_draft: Object.freeze({}) })
  const run = create({ interpretReader(value, dict) { calls.push(value); assert.equal(dict, dictionary); return value.message === 'stock' ? question('stock') : blank() } })
  assert.deepEqual(run(input, dictionary, { question: 'stock' }), question('stock')); assert.equal(calls.length, 2); assert.equal(calls[1].catalog, input.catalog); assert.equal(calls[1].current_draft, input.current_draft); assert.equal(input.message, repeat)
})
test('fallback cannot change draft or introduce unknown schema keys', () => {
  for (const output of [{ ...question('stock'), name: 'PRIVATE' }, question('price'), { ...blank(), intent: 'booking' }, { ...question('stock'), unexpected: null }]) {
    let count = 0; const first = blank(); const run = create({ interpretReader() { return ++count === 1 ? first : output } }); assert.equal(run({ message: repeat }, dictionary, { question: 'stock' }), first); assert.equal(count, 2)
  }
})
test('invalid input never bypasses text checks', () => assert.throws(() => resolve('repeat the last answer\u0000', { question: 'price' }), { code: 'SHADOW_AI_INVALID_REQUEST' }))
