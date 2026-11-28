import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowAiPreOrderInitialAccess } from '../../src/services/shadowAi/shadowAiPreOrderInitialAccess.service.js'

const actorUserId = '11111111-1111-4111-8111-111111111111'
const authorPageId = '22222222-2222-4222-8222-222222222222'
const campaignId = '33333333-3333-4333-8333-333333333333'
const conversationId = '44444444-4444-4444-8444-444444444444'
const other = '55555555-5555-4555-8555-555555555555'
const input = { actorUserId, campaignId, conversationId }
function setup() {
  let clock = 100, allowed = true, resolves = 0, authorizes = 0
  const access = {
    async resolve() { resolves++; if (!allowed) throw new Error('denied'); return authorPageId },
    async authorize() { authorizes++; return allowed },
  }
  return { access, gate: createShadowAiPreOrderInitialAccess({ access, now: () => clock }), setClock: n => { clock = n }, deny: () => { allowed = false }, counts: () => ({ resolves, authorizes }) }
}

test('valid proof is one-use and needs no second access lookup', async () => {
  const { gate, counts } = setup()
  const scope = await gate.prepare(input)
  assert.equal(scope.authorPageId, authorPageId)
  assert.equal(await gate.authorizeInitial(scope), true)
  assert.equal(await gate.authorizeInitial(scope), false)
  assert.deepEqual(counts(), { resolves: 1, authorizes: 0 })
})

test('serialized, forged and other-instance proofs never authorize', async () => {
  const { gate, counts } = setup()
  const scope = await gate.prepare(input)
  assert.equal(await gate.authorizeInitial(JSON.parse(JSON.stringify(scope))), false)
  assert.equal(await gate.authorizeInitial({ ...scope, accessProof: {} }), false)
  assert.equal(await setup().gate.authorizeInitial(scope), false)
  assert.equal(await gate.authorizeInitial({ ...scope, accessProof: null }), false)
  assert.equal(await gate.authorizeInitial(scope), true)
  assert.deepEqual(counts(), { resolves: 1, authorizes: 0 })
})

test('each scope field is bound and a mismatch consumes the proof', async () => {
  const { gate } = setup()
  for (const key of ['actorUserId', 'authorPageId', 'campaignId', 'conversationId']) {
    const scope = await gate.prepare(input)
    assert.equal(await gate.authorizeInitial({ ...scope, [key]: other }), false)
    assert.equal(await gate.authorizeInitial(scope), false)
  }
})

test('expired or backward-clock proofs use live authorization', async () => {
  const state = setup()
  const first = await state.gate.prepare(input)
  state.setClock(5100)
  state.deny()
  assert.equal(await state.gate.authorizeInitial(first), false)
  assert.deepEqual(state.counts(), { resolves: 1, authorizes: 1 })
  const second = setup()
  const scope = await second.gate.prepare(input)
  second.setClock(99)
  assert.equal(await second.gate.authorizeInitial(scope), true)
  assert.deepEqual(second.counts(), { resolves: 1, authorizes: 1 })
})

test('no proof preserves live authorization and access failure propagates', async () => {
  const state = setup()
  assert.equal(await state.gate.authorizeInitial({ ...input, authorPageId }), true)
  state.deny()
  assert.equal(await state.gate.authorizeInitial({ ...input, authorPageId }), false)
  await assert.rejects(state.gate.prepare(input), /denied/)
  assert.deepEqual(state.counts(), { resolves: 1, authorizes: 2 })
})

test('malformed campaign and actor are not granted a proof', async () => {
  const { gate } = setup()
  await assert.rejects(gate.prepare({ ...input, campaignId: 'invalid' }), { code: 'SHADOW_AI_DRAFT_INVALID' })
  await assert.rejects(gate.prepare({ ...input, actorUserId: 'invalid' }), { code: 'SHADOW_AI_DRAFT_INVALID' })
})

test('simultaneous consumption permits only one caller', async () => {
  const { gate } = setup()
  const scope = await gate.prepare(input)
  assert.deepEqual(await Promise.all([gate.authorizeInitial(scope), gate.authorizeInitial(scope)]), [true, false])
})
