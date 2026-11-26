import test from 'node:test'
import assert from 'node:assert/strict'
import { createPromotionQueue, promotionPhotoCacheKeys } from '../src/services/telegramPromotion/queue.service.js'
const storyId = '00000000-0000-4000-8000-000000000001'
const episodeId = '00000000-0000-4000-8000-000000000002'
const jobId = '00000000-0000-4000-8000-000000000003'
const message = { photo: 'https://example.com/cover.jpg', caption: 'Story...', reply_markup: { inline_keyboard: [] } }
function fake(data = jobId, error = null) {
  const calls = []
  const queue = createPromotionQueue({ rpc: async (name, args) => { calls.push({ name, args }); return { data, error } }, from() {} })
  return { calls, queue }
}
const input = { language: 'Khmer', kind: 'update', storyId, episodeId, message, dueAt: '2026-11-26T06:00:00Z' }
test('update dedup key is episode-specific and never expires', async () => {
  const { queue, calls } = fake()
  assert.equal(await queue.enqueue({ ...input, expiresAt: '2026-11-27' }), jobId)
  await queue.enqueue(input)
  assert.deepEqual(calls[0], calls[1])
  assert.equal(calls[0].args.p_job_key, `update:${episodeId}`)
  assert.equal(calls[0].args.p_expires_at, null)
  assert.equal(calls[0].args.p_language, 'km')
})
test('optional posts share one key per slot and require expiration', async () => {
  const { queue, calls } = fake()
  await assert.rejects(queue.enqueue({ ...input, kind: 'completed' }))
  await assert.rejects(queue.enqueue({ ...input, kind: 'completed', slotKey: '2026-11-26T19:00' }))
  await queue.enqueue({ ...input, kind: 'completed', slotKey: '2026-11-26T19:00', expiresAt: '2026-11-26T17:00:00Z' })
  assert.equal(calls[0].args.p_job_key, 'slot:2026-11-26T19:00')
})
test('claim uses normalized channel language', async () => {
  const { queue, calls } = fake(null)
  assert.equal(await queue.claim('Japanese'), null)
  assert.deepEqual(calls[0], { name: 'telegram_promotion_claim_v1', args: { p_language: 'ja' } })
})
test('finish checks attempt and message ID, redacts token', async () => {
  const { queue, calls } = fake(true)
  await assert.rejects(queue.finish({ id: jobId, attempts: 1 }, 'sent'))
  assert.equal(await queue.finish({ id: jobId, attempts: 2 }, 'uncertain', { error: 'bad 123456:abcdefghijklmnop' }), true)
  assert.equal(calls[0].args.p_attempt, 2)
  assert.equal(calls[0].args.p_error, 'bad [redacted]')
  assert.equal(calls[0].args.p_outcome, 'uncertain')
})
test('photo cache isolates bot and original cover using hashes', () => {
  const a = promotionPhotoCacheKeys('123:abc', message.photo)
  assert.match(a.bot_key, /^[a-f0-9]{64}$/)
  assert.notEqual(a.bot_key, promotionPhotoCacheKeys('124:abc', message.photo).bot_key)
  assert.notEqual(a.cover_key, promotionPhotoCacheKeys('123:abc', `${message.photo}?v=2`).cover_key)
})
test('database failures are reported rather than treated as success', async () => {
  const { queue } = fake(null, { message: 'test failure' })
  await assert.rejects(queue.nextDue(), /test failure/)
})
