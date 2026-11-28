import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowLocalTaskRouter } from '../../src/services/shadowAi/local/shadowLocalTaskRouter.js'
import { interpretShadowLocalRequirements } from '../../src/services/shadowAi/local/shadowLocalRequirements.js'
import { previewShadowPreOrderRequirements } from '../../src/services/shadowAi/shadowAiPreOrderRequirements.js'

const actorUserId = '11111111-1111-4111-8111-111111111111'
const cases = [
  ['English', 'require telegram for limited'],
  ['Khmer', 'ត្រូវការតេឡេក្រាម សម្រាប់ ប្រភេទ limited'],
  ['Multiple clauses', 'require second phone; require english signature name for signed'],
  ['Core fields', 'require name; require phone'],
  ['Unsupported instruction', 'require password'],
  ['Ambiguous condition', 'require telegram for limited and signed'],
  ['Empty instruction', ''],
]
for (const [label, instruction] of cases) {
  test(`${label}: same result as existing requirement interpreter with no knowledge read`, async () => {
    let reads = 0
    const run = createShadowLocalTaskRouter({ knowledgeStore: { async getDictionary() { reads++; throw Error('unexpected dictionary read') } }, interpretReader() { assert.fail('reader called') } })
    const input = { instruction }
    assert.deepEqual((await run('author_requirements', input)).data, interpretShadowLocalRequirements(input))
    const original = await previewShadowPreOrderRequirements({ actorUserId, instruction, runAi: async ({ input: value }) => ({ data: interpretShadowLocalRequirements(value) }) })
    const actual = await previewShadowPreOrderRequirements({ actorUserId, instruction, runAi: ({ task, input: value }) => run(task, value) })
    assert.deepEqual(actual, original)
    assert.equal(reads, 0)
  })
}
