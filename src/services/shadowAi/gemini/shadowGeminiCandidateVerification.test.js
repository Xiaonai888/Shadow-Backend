import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyShadowGeminiCandidate as verify } from './shadowGeminiCandidateVerification.js'
import { getShadowGeminiExample, listShadowGeminiExamples } from './shadowGeminiExamples.js'
import { createShadowLocalKnowledgeDictionary } from '../local/shadowLocalKnowledge.js'
import { shadowMatchKey } from '../local/shadowLocalText.js'

const snapshot = { version: 2, aliases: [] }
const row = { group: 'questions', alias: 'what would one copy cost me', canonical: 'price' }
const response = { example_id: 'price_en', test_only: true, knowledge_published: false, reader_fallback_enabled: false, dictionary_version: createShadowLocalKnowledgeDictionary(snapshot).version, engine: 'gemini', question: 'price', external_requests: 1, candidate: row }
const run = (result = response, source = snapshot, exampleId = 'price_en') => verify({ exampleId, result, snapshot: source })
test('valid synthetic classification prepares a candidate only', () => {
  assert.deepEqual(run(), { status: 'verified_for_review', question: 'price', candidate: row, knowledge_published: false })
})
test('all fixed examples check expected categories independently of teacher output', () => {
  for (const { id, text } of listShadowGeminiExamples()) {
    const question = id.split('_')[0]
    const candidate = question === 'unclear' ? null : { group: 'questions', alias: shadowMatchKey(text).replace(/[?？។!！]+$/u, '').trim(), canonical: question }
    const result = { ...response, example_id: id, question, candidate }
    assert.equal(run(result, snapshot, id).status, question === 'unclear' ? 'no_candidate' : 'verified_for_review', id)
    assert.equal(run({ ...result, question: question === 'price' ? 'stock' : 'price' }, snapshot, id).status, 'category_mismatch', id)
  }
})
test('mismatch, untrusted example and malformed metadata never create candidate', () => {
  assert.equal(run({ ...response, question: 'stock' }).status, 'category_mismatch')
  assert.equal(run(response, snapshot, 'private message').status, 'invalid_example')
  for (const patch of [{ example_id: 'stock_en' }, { test_only: false }, { knowledge_published: true }, { reader_fallback_enabled: true }, { external_requests: 2 }, { engine: 'other' }]) assert.equal(run({ ...response, ...patch }).status, 'invalid_result')
})
test('candidate must be exact fixed phrase, category and group with no extra fields', () => {
  for (const candidate of [null, { ...row, alias: 'private name' }, { ...row, canonical: 'stock' }, { ...row, group: 'fields' }, { ...row, private: 'data' }]) assert.equal(run({ ...response, candidate }).status, 'invalid_candidate')
})
test('stale and invalid snapshots do not yield candidate', () => {
  assert.equal(run(response, { ...snapshot, version: 3 }).status, 'stale_knowledge')
  assert.equal(run(response, {}).status, 'invalid_snapshot')
})
test('approved existing knowledge does not produce another candidate', () => {
  const source = { version: 3, aliases: [row] }
  const dictionary_version = createShadowLocalKnowledgeDictionary(source).version
  assert.equal(run({ ...response, dictionary_version, engine: 'local', external_requests: 0, candidate: null }, source).status, 'already_known')
  assert.equal(run({ ...response, dictionary_version }, source).status, 'already_known')
})
test('existing conflicting knowledge is not overridden', () => {
  const source = { version: 3, aliases: [{ ...row, canonical: 'stock' }] }
  assert.equal(run({ ...response, dictionary_version: createShadowLocalKnowledgeDictionary(source).version }, source).status, 'knowledge_conflict')
})
