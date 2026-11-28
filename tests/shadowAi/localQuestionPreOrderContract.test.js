import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowLocalDictionary } from '../../src/services/shadowAi/local/shadowLocalDictionary.js'
import { createShadowLocalQuestionUnderstanding } from '../../src/services/shadowAi/local/shadowLocalQuestionUnderstanding.js'
import { BOOKING_TEXT_LIMITS, parseShadowPreOrderMessage } from '../../src/services/shadowAi/shadowAiPreOrderMessage.js'

const actorUserId = '11111111-1111-4111-8111-111111111111'
const bookId = '22222222-2222-4222-8222-222222222222'
const context = { books: [{ id: bookId, title: 'Moon', editions: [{ edition: 'standard' }] }], delivery_companies: [], signature_enabled: true }
const dictionary = createShadowLocalDictionary()
const blank = () => ({ intent: 'unclear', question: null, items: null, signature_requested: null, ...Object.fromEntries(Object.keys(BOOKING_TEXT_LIMITS).map(key => [key, null])) })
function mockReader(input, dict) {
  if (input.message === 'name: Reader') return { ...blank(), intent: 'booking', name: 'Reader' }
  if (!Array.isArray(input.catalog?.books)) return blank()
  const category = dict.lookup('questions', input.message)
  return category ? { ...blank(), intent: 'question', question: category } : blank()
}
const run = createShadowLocalQuestionUnderstanding({ interpretReader: mockReader })
async function parse(message, interpreter = run) {
  let calls = 0
  const result = await parseShadowPreOrderMessage({ actorUserId, message, context, draft: {}, rules: [], runAi: async ({ input }) => { calls++; return { data: interpreter(input, dictionary) } } })
  assert.equal(calls, 1)
  return result
}
test('question result satisfies existing parser schema and does not write draft fields', async () => {
  assert.deepEqual(await parse('សូមសួរថា តម្លៃប៉ុន្មានបង?'), { intent: 'question', question: 'price', patch: {} })
})
test('recognized booking result unchanged', async () => {
  assert.deepEqual(await parse('name: Reader'), await parse('name: Reader', mockReader))
})
test('unrecognized or ambiguous message remains unclear', async () => {
  assert.deepEqual(await parse('limited price please'), { intent: 'unclear', question: null, patch: {} })
})
test('existing question unchanged', async () => {
  assert.deepEqual(await parse('price'), await parse('price', mockReader))
})
test('invalid catalog remains unclear in fallback', () => {
  assert.deepEqual(run({ message: 'price please' }, dictionary), blank())
})
