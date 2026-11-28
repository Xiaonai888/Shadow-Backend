import test from 'node:test'
import assert from 'node:assert/strict'
import { composeShadowLocalReply as compose } from './shadowLocalReplyComposer.js'
import { normalizeShadowReplyLanguage, readShadowLocalReply } from './shadowLocalReplyLibrary.js'
import { BOOKING_TEXT_LIMITS, parseShadowPreOrderMessage } from '../shadowAiPreOrderMessage.js'

const id = '11111111-1111-4111-8111-111111111111'
const context = { can_book: true, stock_verified: true, signature_enabled: true, books: [{ id, title: 'Moon', editions: [{ edition: 'standard' }] }], delivery_companies: [] }
const validation = { ready: false, missing: ['name'], issues: [], pending_requirements: [] }
const kinds = ['clarify','out_of_scope','missing','review','unavailable','stock_issue','signature_issue','books','price','stock','delivery','signature','schedule','requirements']
for (const locale of ['km','en','zh','ko','ja']) {
  test(`complete static reply library for ${locale}`, () => {
    for (const kind of kinds) {
      const first = readShadowLocalReply(kind, locale)
      assert.equal(first.language, locale)
      assert.equal(typeof first.text, 'string')
      assert.ok(first.text.length > 15 && first.text.length < 600)
      assert.doesNotMatch(first.text, /undefined|null|<script>/i)
      assert.equal(typeof readShadowLocalReply(kind, locale, 1).text, 'string')
    }
    for (const kind of ['clarify','missing']) assert.notEqual(readShadowLocalReply(kind, locale).text, readShadowLocalReply(kind, locale, 1).text)
  })
}
test('language normalization and safe fallback', () => {
  for (const [input, expected] of [[undefined,'km'],['kh','km'],['KM-KH','km'],['en_US','en'],['zh-CN','zh'],['ja-JP','ja'],['ko-KR','ko'],['fr','en'],['constructor','en']]) assert.equal(normalizeShadowReplyLanguage(input), expected)
  assert.deepEqual(readShadowLocalReply('constructor','en'), readShadowLocalReply('unavailable','en'))
})
test('composition returns plain text and no private data or action permission', () => {
  const parsed = Object.freeze({ intent: 'booking', question: null, patch: Object.freeze({ name: 'SECRET NAME', phone_number: '012345678' }) })
  const input = { parsed, context, validation, locale: 'km' }
  const snapshot = JSON.stringify(input)
  const reply = compose(input)
  assert.deepEqual(Object.keys(reply), ['version','language','kind','text','question'])
  assert.equal(reply.kind, 'missing')
  assert.equal(reply.question, null)
  assert.doesNotMatch(JSON.stringify(reply), /SECRET NAME|012345678/)
  assert.equal(JSON.stringify(input), snapshot)
})
test('review message explicitly states draft only', () => {
  const parsed = { intent: 'booking', question: null, patch: { name: 'Reader' } }
  const reply = compose({ parsed, context, validation: { ready: true, missing: [], issues: [], pending_requirements: [] }, locale: 'en' })
  assert.equal(reply.kind, 'review')
  assert.match(reply.text, /not a completed order or payment/)
})
test('verified question uses context card category without inventing price', async () => {
  const data = { intent: 'question', question: 'price', items: null, signature_requested: null, ...Object.fromEntries(Object.keys(BOOKING_TEXT_LIMITS).map(key => [key, null])) }
  let calls = 0
  const parsed = await parseShadowPreOrderMessage({ actorUserId: id, message: 'price', context, draft: {}, rules: [], runAi: async () => { calls++; return { data } } })
  const reply = compose({ parsed, context, validation, locale: 'en' })
  assert.equal(reply.kind, 'price')
  assert.equal(reply.question, 'price')
  assert.doesNotMatch(reply.text, /\$\d/)
  assert.equal(calls, 1)
})
test('clarification variants require no state or network', () => {
  const input = { parsed: { intent: 'unclear', question: null, patch: {} }, locale: 'km' }
  const original = globalThis.fetch
  globalThis.fetch = () => { throw Error('network forbidden') }
  try {
    assert.notEqual(compose(input).text, compose({ ...input, variant: 1 }).text)
    assert.deepEqual(compose(input), compose({ ...input, variant: -1 }))
    assert.deepEqual(compose(input), compose(input))
  } finally { globalThis.fetch = original }
})
