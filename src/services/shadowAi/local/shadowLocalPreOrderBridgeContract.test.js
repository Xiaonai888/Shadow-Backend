import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowLocalPreOrderBridge } from './shadowLocalPreOrderBridge.js'
import { createShadowLocalDictionary } from './shadowLocalDictionary.js'
import { mergeShadowBookingDraft, inspectShadowBookingDraft } from '../shadowAiPreOrderDraft.js'
import { parseShadowPreOrderMessage } from '../shadowAiPreOrderMessage.js'
import { interpretShadowLocalFollowup } from './shadowLocalFollowup.js'

const scope = { actorUserId: '11111111-1111-4111-8111-111111111111', authorPageId: '22222222-2222-4222-8222-222222222222', campaignId: '33333333-3333-4333-8333-333333333333', conversationId: '44444444-4444-4444-8444-444444444444' }
const id = '55555555-5555-4555-8555-555555555555'
const context = { author_page_id: scope.authorPageId, campaign_id: scope.campaignId, can_book: true, stock_verified: true, books: [{ id, title: 'Moon', editions: [{ edition: 'standard', available: 2 }, { edition: 'limited', available: 1 }] }], delivery_companies: [{ company_key: 'sample', company_name: 'Sample' }], signature_enabled: false }
const dictionary = createShadowLocalDictionary()
const before = mergeShadowBookingDraft(context, { items: [{ book_id: id, edition: 'standard', quantity: null }], name: 'Example Reader', phone_number: '012345678', delivery_address: 'Phnom Penh' })
const rules = []
for (const message of ['price', '2 copies', '3 copies', 'name: Example Buyer', 'not a supported question']) {
  test(`preserves existing draft and validation contract: ${message}`, async () => {
    const bridge = createShadowLocalPreOrderBridge()
    const runAi = async (request, meta) => ({ data: bridge.interpretReader(request.input, dictionary, meta) })
    const parsed = await parseShadowPreOrderMessage({ actorUserId: scope.actorUserId, message, context, draft: before, rules, runAi: async request => ({ data: interpretShadowLocalFollowup(request.input, dictionary) }) })
    const draft = mergeShadowBookingDraft(context, before, parsed.patch), validation = inspectShadowBookingDraft(context, draft, rules)
    const turn = await bridge.prepareTurn({ scope, revision: 2, message, context, before, rules, runAi })
    const { reply, ...legacy } = turn
    assert.deepEqual(legacy, { campaign_id: scope.campaignId, author_page_id: scope.authorPageId, intent: parsed.intent, question: parsed.question, draft, validation, ready_for_review: validation.ready, order_created: false, payment_created: false, inventory_reserved: false })
    assert.equal(typeof reply.text, 'string')
    if (message === '3 copies') { assert.equal(reply.kind, 'stock_issue'); assert.equal(turn.ready_for_review, false) }
    if (message === '2 copies') assert.equal(turn.ready_for_review, true)
  })
}
test('existing confirmed requirements still block review', async () => {
  const bridge = createShadowLocalPreOrderBridge()
  const turn = await bridge.prepareTurn({ scope, revision: 2, message: '2 copies', context, before, rules: [{ field: 'second_phone', condition: 'always' }], runAi: async (request, meta) => ({ data: bridge.interpretReader(request.input, dictionary, meta) }) })
  assert.equal(turn.ready_for_review, false); assert.ok(turn.validation.missing.includes('second_phone')); assert.equal(turn.order_created, false)
})
