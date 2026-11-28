import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowLocalLearningCandidates as create } from './shadowLocalLearningCandidates.js'

const snapshot = { version: 1, aliases: [] }
const alias = { group: 'questions', alias: 'cost of book', canonical: 'price' }
const proposal = overrides => ({ alias, snapshot, reviewedPublicPhrase: true, ...overrides })
test('candidate is pending and normalized, duplicate is not stored twice', () => {
  const store = create()
  const first = store.propose(proposal())
  assert.equal(first.status, 'pending_review')
  assert.deepEqual(store.propose(proposal({ alias: { ...alias, alias: ' COST  OF BOOK ' } })), first)
  assert.equal(store.list().length, 1)
  first.alias.alias = 'changed'
  assert.equal(store.list()[0].alias.alias, alias.alias)
})
test('requires curated public phrase and valid existing knowledge', () => {
  const store = create()
  for (const input of [proposal({ reviewedPublicPhrase: false }), proposal({ snapshot: null }), proposal({ alias: { ...alias, alias: '012345678' } }), proposal({ alias: { ...alias, alias: 'reader@example.com' } }), proposal({ alias: { ...alias, canonical: 'payment' } })]) assert.throws(() => store.propose(input), { code: 'SHADOW_AI_KNOWLEDGE_INVALID' })
  assert.equal(store.list().length, 0)
})
test('base and current aliases are not duplicated or remapped', () => {
  const store = create()
  assert.equal(store.propose(proposal({ alias: { ...alias, alias: 'price' } })).status, 'already_known')
  assert.equal(store.propose(proposal({ snapshot: { version: 1, aliases: [alias] } })).status, 'already_known')
  assert.throws(() => store.propose(proposal({ snapshot: { version: 1, aliases: [{ ...alias, canonical: 'stock' }] } })), { code: 'SHADOW_AI_KNOWLEDGE_CONFLICT' })
  assert.equal(store.list().length, 0)
})
test('approval prepares payload only and rejects stale versions', () => {
  const store = create(), candidate = store.propose(proposal())
  assert.throws(() => store.prepareApproval({ key: candidate.key, snapshot, approved: false }), { code: 'SHADOW_AI_KNOWLEDGE_INVALID' })
  assert.throws(() => store.prepareApproval({ key: candidate.key, snapshot: { ...snapshot, version: 2 }, approved: true }), { code: 'SHADOW_AI_KNOWLEDGE_CONFLICT' })
  assert.deepEqual(store.prepareApproval({ key: candidate.key, snapshot, approved: true }), { expected_version: 1, aliases: [alias] })
  assert.deepEqual(snapshot.aliases, [])
  assert.equal(store.list()[0].status, 'pending_review')
})
test('pending conflicts and capacity are bounded; rejection frees a slot', () => {
  const store = create({ maxPending: 1 }), candidate = store.propose(proposal())
  assert.throws(() => store.propose(proposal({ alias: { ...alias, canonical: 'stock' } })), { code: 'SHADOW_AI_KNOWLEDGE_CONFLICT' })
  const other = proposal({ alias: { ...alias, alias: 'book pricing' } })
  assert.throws(() => store.propose(other), { code: 'SHADOW_AI_LEARNING_LIMIT' })
  assert.equal(store.reject(candidate.key), true)
  assert.equal(store.propose(other).status, 'pending_review')
})
