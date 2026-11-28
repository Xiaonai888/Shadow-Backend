import test from 'node:test'
import assert from 'node:assert/strict'
import { BOOKING_TEXT_LIMITS, parseShadowPreOrderMessage } from '../shadowAiPreOrderMessage.js'
import { createShadowLocalDictionary } from './shadowLocalDictionary.js'
import { createShadowLocalShortMemory } from './shadowLocalShortMemory.js'
import { createShadowLocalMemoryUnderstanding } from './shadowLocalMemoryUnderstanding.js'

const scope = { actorUserId: '11111111-1111-4111-8111-111111111111', authorPageId: '22222222-2222-4222-8222-222222222222', campaignId: '33333333-3333-4333-8333-333333333333', conversationId: '44444444-4444-4444-8444-444444444444' }
const dictionary = createShadowLocalDictionary()
const blank = () => ({ intent: 'unclear', question: null, items: null, signature_requested: null, ...Object.fromEntries(Object.keys(BOOKING_TEXT_LIMITS).map(key => [key, null])) })
const interpreter = createShadowLocalMemoryUnderstanding({ interpretReader(input, dict) { const question = dict.lookup('questions', input.message); return question ? { ...blank(), intent: 'question', question } : blank() } })
async function parse(message, remembered, context) {
  let calls = 0
  const output = await parseShadowPreOrderMessage({ actorUserId: scope.actorUserId, message, context, draft: {}, rules: [], runAi: async ({ input }) => { calls++; return { data: interpreter(input, dictionary, remembered) } } })
  assert.equal(calls, 1); return output
}
test('repeated question satisfies parser contract without writing booking patch', async () => {
  const m = createShadowLocalShortMemory(), context = { books: [], delivery_companies: [], signature_enabled: false }
  const first = await parse('price', null, context); m.remember({ scope, revision: 0, ...first }); const second = await parse('repeat the last answer', m.read({ scope, revision: 0 }), context)
  assert.deepEqual(second, { intent: 'question', question: 'price', patch: {} })
})
test('expired or different revision memory leaves follow-up unclear', async () => {
  let time = 0; const m = createShadowLocalShortMemory({ now: () => time }), context = { books: [], delivery_companies: [], signature_enabled: false }
  m.remember({ scope, revision: 0, intent: 'question', question: 'price' }); time = 600000
  assert.deepEqual(await parse('repeat the last answer', m.read({ scope, revision: 0 }), context), { intent: 'unclear', question: null, patch: {} })
})
