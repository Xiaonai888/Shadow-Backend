import test from 'node:test'
import assert from 'node:assert/strict'
import { BOOKING_TEXT_LIMITS, parseShadowPreOrderMessage } from '../shadowAiPreOrderMessage.js'
import { createShadowLocalDictionary } from './shadowLocalDictionary.js'
import { createShadowLocalContextUnderstanding } from './shadowLocalContextUnderstanding.js'
import { assessShadowLocalConfidence } from './shadowLocalConfidence.js'

const actorUserId = '11111111-1111-4111-8111-111111111111', bookId = '22222222-2222-4222-8222-222222222222'
const context = { books: [{ id: bookId, title: 'Moon', editions: [{ edition: 'standard' }, { edition: 'limited' }] }], delivery_companies: [], signature_enabled: true, stock_verified: true, can_book: true }
const dictionary = createShadowLocalDictionary()
const draft = { items: [{ book_id: bookId, edition: null, quantity: null }] }
const blank = () => ({ intent: 'unclear', question: null, items: null, signature_requested: null, ...Object.fromEntries(Object.keys(BOOKING_TEXT_LIMITS).map(key => [key, null])) })
function fixture() {
  let runtimeCalls = 0, localCalls = 0
  const run = createShadowLocalContextUnderstanding({ interpretReader(input, dict) {
    localCalls++
    const question = dict.lookup('questions', input.message)
    if (question) return { ...blank(), intent: 'question', question }
    if (input.message === 'edition: limited\nquantity: 2') return { ...blank(), intent: 'booking', items: [{ book_id: input.current_draft.items[0].book_id, edition: 'limited', quantity: 2 }] }
    return blank()
  } })
  return { counts: () => [runtimeCalls, localCalls], parse: (message, current = draft) => parseShadowPreOrderMessage({ actorUserId, message, context, draft: current, rules: [], runAi: async ({ input }) => { runtimeCalls++; return { data: run(input, dictionary) } } }) }
}

test('context output passes existing real parser and confidence evaluator with one runtime call', async () => {
  const f = fixture()
  const parsed = await f.parse('យក Limited ២ក្បាល')
  assert.deepEqual(parsed, { intent: 'booking', question: null, patch: { items: [{ book_id: bookId, edition: 'limited', quantity: 2 }] } })
  const confidence = assessShadowLocalConfidence({ parsed, context, validation: { ready: false, missing: ['name'], issues: [], pending_requirements: [] } })
  assert.equal(confidence.decision, 'ask_missing_details')
  assert.deepEqual(f.counts(), [1, 2])
})

test('ordinary questions preserve original parser contract', async () => {
  const f = fixture()
  assert.deepEqual(await f.parse('price'), { intent: 'question', question: 'price', patch: {} })
  assert.deepEqual(f.counts(), [1, 1])
})

test('without selected book no booking patch is created', async () => {
  const f = fixture()
  assert.deepEqual(await f.parse('limited 2 copies', {}), { intent: 'unclear', question: null, patch: {} })
  assert.deepEqual(f.counts(), [1, 1])
})

test('previous conflicting choices stay unchanged', async () => {
  const f = fixture()
  const previous = { items: [{ book_id: bookId, edition: 'standard', quantity: 1 }] }
  const before = JSON.stringify(previous)
  assert.deepEqual(await f.parse('limited 2 copies', previous), { intent: 'unclear', question: null, patch: {} })
  assert.equal(JSON.stringify(previous), before)
  assert.deepEqual(f.counts(), [1, 1])
})
