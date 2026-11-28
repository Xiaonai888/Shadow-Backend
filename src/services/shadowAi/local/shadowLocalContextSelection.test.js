import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowLocalDictionary } from './shadowLocalDictionary.js'
import { matchShadowLocalContextSelection as match } from './shadowLocalContextSelection.js'

const dictionary = createShadowLocalDictionary()
const id = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222'
const book = { id, title: 'Moon', editions: ['standard', 'limited'] }
const input = (message, items = [{ book_id: id, edition: null, quantity: null }], books = [book]) => ({ message, current_draft: { items }, catalog: { books, delivery_companies: [] } })

for (const [message, edition, quantity, rewritten] of [
  ['យក Limited ២ក្បាល', 'limited', 2, 'edition: limited\nquantity: 2'],
  ['សូមយក ធម្មតា ១ច្បាប់', 'standard', 1, 'edition: standard\nquantity: 1'],
  ["I'll take limited 3 copies", 'limited', 3, 'edition: limited\nquantity: 3'],
  ['Limited ２ copies', 'limited', 2, 'edition: limited\nquantity: 2'],
  ['យក Normal', 'standard', null, 'edition: standard'],
  ['យក ២ក្បាល', null, 2, 'quantity: 2'],
]) test(`explicit context selection ${message}`, () => assert.deepEqual(match(input(message), dictionary), { message: rewritten, expected: { book_id: id, edition, quantity } }))

test('only fills a missing value and preserves matching existing selection', () => {
  assert.deepEqual(match(input('limited 2 copies', [{ book_id: id, edition: 'limited', quantity: null }]), dictionary), { message: 'quantity: 2', expected: { book_id: id, edition: 'limited', quantity: 2 } })
  assert.deepEqual(match(input('limited 2 copies', [{ book_id: id, edition: null, quantity: 2 }]), dictionary), { message: 'edition: limited', expected: { book_id: id, edition: 'limited', quantity: 2 } })
})

test('does not guess bare numbers, confirmation, questions, negation or mixed text', () => {
  for (const text of ['2', 'yes', 'យក', 'អាទីមួយ 2', 'limited 2 copies?', 'not limited 2 copies', 'មិនយក limited 2 ក្បាល', 'limited 0 copies', 'limited 100 copies', 'limited 02 copies', 'limited 1.5 copies', 'limited 2 copies and normal', 'limited 2 copies\nphone: 012345678', 'price limited', 'limited 2 copies; note', 'limited 2', '2 copies limited']) assert.equal(match(input(text), dictionary), null, text)
})

test('does not select book without a unique valid existing selection', () => {
  for (const items of [[], null, [{ book_id: other, edition: null, quantity: null }], [{ book_id: id, edition: null, quantity: null }, { book_id: other, edition: null, quantity: null }], [{ book_id: id, edition: undefined, quantity: null }], [{ book_id: id, edition: null, quantity: 0 }]]) assert.equal(match(input('limited 2 copies', items), dictionary), null)
  assert.equal(match(input('limited 2 copies', undefined, [book, book]), dictionary), null)
  assert.equal(match(input('limited 2 copies', undefined, [{ ...book, editions: ['standard'] }]), dictionary), null)
  assert.equal(match(input('limited 2 copies', undefined, [{ ...book, editions: null }]), dictionary), null)
})

test('conflicting or already filled draft values are not overwritten', () => {
  for (const item of [{ book_id: id, edition: 'standard', quantity: null }, { book_id: id, edition: null, quantity: 1 }, { book_id: id, edition: 'limited', quantity: 2 }]) assert.equal(match(input('limited 2 copies', [item]), dictionary), null)
})

test('learned edition alias is reused via the provided dictionary', () => {
  const learned = { lookup(group, value) { return group === 'editions' && value === 'special edition' ? 'limited' : dictionary.lookup(group, value) } }
  assert.equal(match(input('special edition 2 copies'), learned).expected.edition, 'limited')
})

test('existing input limits remain enforced', () => {
  assert.throws(() => match(input('limited\u0000'), dictionary), { code: 'SHADOW_AI_INVALID_REQUEST' })
  assert.throws(() => match(input('x'.repeat(2001)), dictionary), { code: 'SHADOW_AI_INVALID_REQUEST' })
  assert.equal(match(input('x'.repeat(161)), dictionary), null)
})
