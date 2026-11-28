import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowAiPreOrderAccess } from '../../src/services/shadowAi/shadowAiPreOrderAccess.service.js'
import { createShadowAiPreOrderInitialAccess } from '../../src/services/shadowAi/shadowAiPreOrderInitialAccess.service.js'

const actorUserId = '11111111-1111-4111-8111-111111111111'
const authorPageId = '22222222-2222-4222-8222-222222222222'
const campaignId = '33333333-3333-4333-8333-333333333333'
const conversationId = '44444444-4444-4444-8444-444444444444'
const authorUserId = '55555555-5555-4555-8555-555555555555'
const input = { actorUserId, campaignId, conversationId }

function fixture() {
  let blocked = false, databaseError = false
  const calls = []
  const rows = {
    chat_conversations: { id: conversationId, conversation_type: 'reader_author', is_group: false, request_status: 'accepted', author_page_id: authorPageId },
    chat_participants: [{ user_id: actorUserId, participant_role: 'reader', deleted_at: null }, { user_id: authorUserId, participant_role: 'author', deleted_at: null }],
    author_pages: { id: authorPageId, user_id: authorUserId, status: 'active' },
  }
  const db = { from(table) {
    const chain = {
      select() { return chain }, eq() { return chain }, limit() { return chain }, or() { return chain }, maybeSingle() { return chain },
      async abortSignal() {
        calls.push(table)
        if (databaseError) return { error: new Error('mock database unavailable') }
        return { data: table === 'chat_blocks' ? (blocked ? [{ id: 'blocked' }] : []) : rows[table], error: null }
      },
    }
    return chain
  } }
  const access = createShadowAiPreOrderAccess({ db })
  return { access, gate: createShadowAiPreOrderInitialAccess({ access }), calls, block: () => { blocked = true }, deactivate: () => { rows.author_pages.status = 'inactive' }, fail: () => { databaseError = true } }
}

async function baseline({ access }, finalCheck) {
  const scope = { ...input, authorPageId: await access.resolve(input) }
  assert.equal(await access.authorize(scope), true)
  if (finalCheck) assert.equal(await access.authorize(scope), true)
}

async function candidate({ gate, access }, finalCheck) {
  const scope = await gate.prepare(input)
  assert.equal(await gate.authorizeInitial(scope), true)
  if (finalCheck) assert.equal(await access.authorize(scope), true)
}

test('open access path: actual access service with mocked database, 8 to 4 queries', async () => {
  const before = fixture(), after = fixture()
  await baseline(before, false)
  await candidate(after, false)
  assert.equal(before.calls.length, 8)
  assert.equal(after.calls.length, 4)
})

test('message or review access path: actual access service, 12 to 8 queries', async () => {
  const before = fixture(), after = fixture()
  await baseline(before, true)
  await candidate(after, true)
  assert.equal(before.calls.length, 12)
  assert.equal(after.calls.length, 8)
})

test('fresh final check rejects new block or inactive author', async () => {
  for (const change of ['block', 'deactivate']) {
    const state = fixture()
    const scope = await state.gate.prepare(input)
    assert.equal(await state.gate.authorizeInitial(scope), true)
    state[change]()
    await assert.rejects(state.access.authorize(scope), { code: 'SHADOW_AI_SESSION_DENIED' })
  }
})

test('initial lookup rejects blocked and unavailable access', async () => {
  const blocked = fixture()
  blocked.block()
  await assert.rejects(blocked.gate.prepare(input), { code: 'SHADOW_AI_SESSION_DENIED' })
  const unavailable = fixture()
  unavailable.fail()
  await assert.rejects(unavailable.gate.prepare(input), { code: 'SHADOW_AI_ACCESS_UNAVAILABLE' })
})

test('independent requests never reuse each other or cache access across requests', async () => {
  const state = fixture()
  await candidate(state, true)
  await candidate(state, true)
  assert.equal(state.calls.length, 16)
  state.block()
  await assert.rejects(state.gate.prepare(input), { code: 'SHADOW_AI_SESSION_DENIED' })
})
