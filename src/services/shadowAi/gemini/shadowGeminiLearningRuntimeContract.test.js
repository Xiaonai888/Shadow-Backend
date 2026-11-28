import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createShadowGeminiLearningRuntime } from './shadowGeminiLearningRuntime.service.js'

test('singleton shares management and knowledge cache and never auto-starts', async () => {
  const source = await readFile(new URL('./shadowGeminiLearningInstance.service.js', import.meta.url), 'utf8')
  assert.match(source, /const \{ knowledgeAdmin, knowledgeStore \} = shadowLocalInstance/)
  assert.equal((source.match(/createShadowGeminiManagement\(/g) ?? []).length, 1)
  assert.equal((source.match(/createShadowGeminiLearningRuntime\(/g) ?? []).length, 1)
  assert.doesNotMatch(source, /\.start\(/)
})
test('runtime requires existing management and knowledge dependencies', () => {
  assert.throws(() => createShadowGeminiLearningRuntime({ db: { rpc() {} } }), TypeError)
})
