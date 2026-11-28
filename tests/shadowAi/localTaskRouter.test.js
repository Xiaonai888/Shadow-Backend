import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowLocalTaskRouter } from '../../src/services/shadowAi/local/shadowLocalTaskRouter.js'
import { SHADOW_LOCAL_REQUIREMENTS_VERSION } from '../../src/services/shadowAi/local/shadowLocalRequirementDictionary.js'

function fixture() {
  let reads = 0, readerCalls = 0
  let dictionary = { version: 'reader-v1' }
  const run = createShadowLocalTaskRouter({
    knowledgeStore: { async getDictionary() { reads++; return dictionary } },
    interpretReader(input, value) { readerCalls++; assert.equal(value, dictionary); return { message: input.message } },
  })
  return { run, reads: () => reads, readerCalls: () => readerCalls, update(value) { dictionary = value } }
}
test('author task does not load reader dictionary or execute reader interpreter', async () => {
  const f = fixture()
  assert.deepEqual(await f.run('author_requirements', { instruction: 'require telegram for limited' }), {
    data: { rules: [{ field: 'telegram_username', condition: 'limited' }], needs_review: [] },
    dictionaryVersion: SHADOW_LOCAL_REQUIREMENTS_VERSION,
  })
  assert.equal(f.reads(), 0)
  assert.equal(f.readerCalls(), 0)
})
test('reader task loads existing dictionary and invokes reader once', async () => {
  const f = fixture()
  assert.deepEqual(await f.run('reader_message', { message: 'price' }), { data: { message: 'price' }, dictionaryVersion: 'reader-v1' })
  assert.equal(f.reads(), 1)
  assert.equal(f.readerCalls(), 1)
})
test('reader receives new dictionary versions without router-level caching', async () => {
  const f = fixture()
  await f.run('reader_message', { message: 'price' })
  f.update({ version: 'reader-v2' })
  assert.equal((await f.run('reader_message', { message: 'stock' })).dictionaryVersion, 'reader-v2')
  assert.equal(f.reads(), 2)
})
test('unknown task rejected without lookup or interpreter', async () => {
  const f = fixture()
  await assert.rejects(f.run('other', {}), { code: 'SHADOW_AI_INVALID_REQUEST' })
  assert.equal(f.reads(), 0)
  assert.equal(f.readerCalls(), 0)
})
test('reader dictionary error is propagated without retry', async () => {
  const failure = new Error('read failed')
  let count = 0
  const run = createShadowLocalTaskRouter({ knowledgeStore: { async getDictionary() { count++; throw failure } }, interpretReader() { assert.fail('reader called') } })
  await assert.rejects(run('reader_message', {}), error => error === failure)
  assert.equal(count, 1)
})
test('invalid router dependencies fail at setup', () => {
  assert.throws(() => createShadowLocalTaskRouter(), TypeError)
  assert.throws(() => createShadowLocalTaskRouter({ knowledgeStore: { getDictionary() {} } }), TypeError)
})
test('author instruction validation remains fail closed without reader lookup', async () => {
  const f = fixture()
  await assert.rejects(f.run('author_requirements', { instruction: 'x'.repeat(301) }), { code: 'SHADOW_AI_INVALID_REQUEST' })
  assert.equal(f.reads(), 0)
})
