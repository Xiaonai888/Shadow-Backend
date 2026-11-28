import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowLocalDictionary } from '../../src/services/shadowAi/local/shadowLocalDictionary.js'
import { matchShadowLocalQuestionEnvelope as match, createShadowLocalQuestionUnderstanding as create } from '../../src/services/shadowAi/local/shadowLocalQuestionUnderstanding.js'

const dictionary = createShadowLocalDictionary()
const unknown = Object.freeze({ intent: 'unclear', question: null, items: null })
const recognized = question => ({ intent: 'question', question, items: null })

for (const [message, question] of [
  ['សុំសួរបន្តិច តម្លៃប៉ុន្មានបង?', 'price'],
  ['សូមជួយប្រាប់ខ្ញុំថា នៅសល់ប៉ុន្មានផងណា?', 'stock'],
  ['ខ្ញុំចង់ដឹងថា ដឹកប៉ុន្មាន', 'delivery'],
  ['មានស៊ីញ៉េអត់បង?', 'signature'],
  ['បិទកក់ថ្ងៃណាដែរ?', 'schedule'],
  ['សូមសួរថា ត្រូវការអ្វីខ្លះផង', 'requirements'],
  ['Could you please tell me which books are available?', 'books'],
  ['Can you tell me how much, please?', 'price'],
  ['shipping cost please', 'delivery'],
  ['I would like to know when will it ship', 'schedule'],
]) test(`recognizes ${message}`, () => assert.equal(match(message, dictionary)?.question, question))

test('never strips qualifiers, negation, unrelated text, multiple questions or booking fields', () => {
  for (const message of ['Limited price please', 'price for 2 books please', 'not stock please', 'price and stock please', 'price? stock please', 'please tell me price\nname: Test', 'សូមសួរថា មិនយកស៊ីញ៉េបង', 'កក់ Moon 2 copies please', 'phone: 012345678 please', 'please', 'price', 'price?', 'please tell me '+ 'x'.repeat(321)]) assert.equal(match(message, dictionary), null, message)
})
test('normalization never bypasses existing input checks', () => {
  assert.throws(() => match('price\u0000 please', dictionary), { code: 'SHADOW_AI_INVALID_REQUEST' })
  assert.throws(() => match('a'.repeat(2001), dictionary), { code: 'SHADOW_AI_INVALID_REQUEST' })
})
test('uses an approved alias in the supplied dictionary without a new store', () => {
  const learned = { lookup(group, value) { return group === 'questions' && value === 'book cost please' ? 'price' : dictionary.lookup(group, value) } }
  assert.equal(match('please tell me book cost please?', learned)?.question, 'price')
})
test('conflicting categories fail closed', () => {
  const learned = { lookup(group, value) { return group === 'questions' ? ({ 'price please': 'stock', 'please tell me price': 'delivery', price: 'price' })[value] : null } }
  assert.equal(match('please tell me price please', learned), null)
})
test('existing recognized output wins without a retry', () => {
  const existing = { intent: 'booking', question: null, items: [{ quantity: 1 }] }
  let count = 0
  const run = create({ interpretReader() { count++; return existing } })
  assert.equal(run({ message: 'price please' }, dictionary), existing)
  assert.equal(count, 1)
})
test('fallback only runs once, with the same catalog and dictionary', () => {
  const calls = []
  const input = Object.freeze({ message: 'price please', current_draft: Object.freeze({}), catalog: Object.freeze({}) })
  const run = create({ interpretReader(value, dict) { calls.push(value); assert.equal(dict, dictionary); return value.message === 'price' ? recognized('price') : unknown } })
  assert.deepEqual(run(input, dictionary), recognized('price'))
  assert.equal(calls.length, 2)
  assert.equal(calls[1].catalog, input.catalog)
  assert.equal(calls[1].current_draft, input.current_draft)
  assert.equal(input.message, 'price please')
})
test('a second interpretation cannot introduce booking data or mismatched categories', () => {
  for (const output of [{ ...recognized('price'), name: 'PRIVATE' }, recognized('stock'), { intent: 'booking', items: [] }, unknown]) {
    let count = 0
    const run = create({ interpretReader() { return ++count === 1 ? unknown : output } })
    assert.equal(run({ message: 'price please' }, dictionary), unknown)
    assert.equal(count, 2)
  }
})
test('unknown text is interpreted once only', () => {
  let count = 0
  const run = create({ interpretReader() { count++; return unknown } })
  assert.equal(run({ message: 'nothing recognizable' }, dictionary), unknown)
  assert.equal(count, 1)
})
