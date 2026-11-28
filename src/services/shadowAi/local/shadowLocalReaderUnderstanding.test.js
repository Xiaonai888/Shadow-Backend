import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowLocalReaderUnderstanding } from './shadowLocalReaderUnderstanding.js'
import { createShadowLocalDictionary } from './shadowLocalDictionary.js'
import { BOOKING_TEXT_LIMITS } from '../shadowAiPreOrderMessage.js'

const id = '11111111-1111-4111-8111-111111111111'
const dict = createShadowLocalDictionary()
const blank = () => ({ intent: 'unclear', question: null, items: null, signature_requested: null, ...Object.fromEntries(Object.keys(BOOKING_TEXT_LIMITS).map(key => [key, null])) })
const input = message => ({ message, current_draft: { items: [{ book_id: id, edition: null, quantity: null }] }, catalog: { books: [{ id, editions: ['standard', 'limited'] }] } })
function fixture({ failRetry = false } = {}) {
  const calls = []
  const interpretReader = value => {
    calls.push(['reader', value.message])
    const question = dict.lookup('questions', value.message)
    return question && !(failRetry && calls.length > 1) ? { ...blank(), intent: 'question', question } : blank()
  }
  const interpretSelection = value => {
    calls.push(['selection', value.message])
    return { ...blank(), intent: 'booking', items: [{ book_id: id, edition: 'limited', quantity: 2 }] }
  }
  return { calls, run: createShadowLocalReaderUnderstanding({ interpretReader, interpretSelection }) }
}
test('legacy known question uses one interpreter call', () => { const f = fixture(); assert.equal(f.run(input('price'), dict).question, 'price'); assert.equal(f.calls.length, 1) })
test('polite question uses at most one retry', () => { const f = fixture(); assert.equal(f.run(input('please tell me price'), dict).question, 'price'); assert.equal(f.calls.length, 2) })
test('context selection uses dedicated selection interpreter once', () => { const f = fixture(); assert.equal(f.run(input('limited 2 copies'), dict).items[0].quantity, 2); assert.deepEqual(f.calls, [['reader', 'limited 2 copies'], ['selection', 'edition: limited\nquantity: 2']]) })
test('repeat resolves only with remembered question', () => { const f = fixture(); assert.equal(f.run(input('repeat the last answer'), dict, { question: 'stock' }).question, 'stock'); assert.equal(f.calls.length, 2) })
test('unknown text or absent memory never repeats base parse', () => { for (const text of ['unrecognized phrase', 'repeat the last answer']) { const f = fixture(); assert.equal(f.run(input(text), dict).intent, 'unclear'); assert.equal(f.calls.length, 1) } })
test('failed verification stops without another retry', () => { const f = fixture({ failRetry: true }); assert.equal(f.run(input('please tell me price'), dict, { question: 'stock' }).intent, 'unclear'); assert.equal(f.calls.length, 2) })
test('explicit direct question overrides remembered topic', () => { const f = fixture(); assert.equal(f.run(input('price'), dict, { question: 'stock' }).question, 'price'); assert.equal(f.calls.length, 1) })
