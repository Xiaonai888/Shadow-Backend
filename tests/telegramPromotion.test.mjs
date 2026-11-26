import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluatePromotion, PROMOTION_SCHEDULE, cambodiaDay } from '../src/services/telegramPromotion/policy.service.js'
import { extractPromotionText, promotionPlainText } from '../src/services/telegramPromotion/extractor.service.js'
import { buildPromotionMessage } from '../src/services/telegramPromotion/message.service.js'
import { sendPromotionPhoto } from '../src/services/telegramPromotion/telegram.service.js'
const now = Date.parse('2026-11-26T06:00:00Z')
const story = { id: 'story1', title: 'រឿងសាកល្បង', story_language: 'Khmer', status: 'published', story_status: 'Ongoing', cover_url: 'https://example.com/cover.jpg' }
const episode = { id: 'ep1', story_id: story.id, status: 'published', first_published_at: '2026-11-26T05:00:00Z', episode_number: 1, is_locked: true, content: '<p>អត្ថបទរឿងសាកល្បង</p>'.repeat(100) }
const options = { story, episode, language: 'km', now, kind: 'update' }
test('new locked episodes qualify; private, adult and future episodes do not', () => {
  assert.equal(evaluatePromotion(options).eligible, true)
  assert.equal(evaluatePromotion({ ...options, story: { ...story, is_adult: true } }).eligible, false)
  assert.equal(evaluatePromotion({ ...options, episode: { ...episode, status: 'draft' } }).eligible, false)
  assert.equal(evaluatePromotion({ ...options, episode: { ...episode, first_published_at: '2026-11-27' } }).eligible, false)
})
test('completed exemption and ongoing activity checks', () => {
  assert.equal(evaluatePromotion({ ...options, kind: 'completed', story: { ...story, story_status: 'Completed' } }).eligible, true)
  assert.equal(evaluatePromotion({ ...options, kind: 'trending' }).eligible, false)
  assert.equal(evaluatePromotion({ ...options, kind: 'trending', authorLastActiveAt: '2026-11-25', lastEpisodePublishedAt: '2026-11-25' }).eligible, true)
})
test('Cambodia date and weekly schedule', () => {
  assert.equal(cambodiaDay(Date.parse('2026-11-25T18:00:00Z')), '2026-11-26')
  assert.equal(PROMOTION_SCHEDULE.length, 12)
})
test('excerpt caps, markup and graphemes', () => {
  assert.equal(promotionPlainText('<script>hidden</script><p>A &amp; B</p><p>C</p>'), 'A & B\nC')
  assert.equal(extractPromotionText('abcdefghij'), 'abc...')
  assert.equal(extractPromotionText('a\n'.repeat(100), { maxLines: 15 }).split('\n').length, 15)
  assert.equal(extractPromotionText('😀'.repeat(100), { budget: 8 }), '😀😀...')
  assert.equal(extractPromotionText('abc'), '')
})
test('five languages, original cover, caption cap and four links', () => {
  for (const language of ['Khmer', 'English', 'Chinese', 'Korean', 'Japanese']) {
    const message = buildPromotionMessage({ ...options, language, story: { ...story, story_language: language } })
    assert.ok(message.caption.length <= 1000)
    assert.ok(message.caption.endsWith('...'))
    assert.equal(message.photo, story.cover_url)
    assert.equal(message.reply_markup.inline_keyboard.flat().length, 4)
    assert.equal(message.reply_markup.inline_keyboard[0][0].url, 'https://www.shadowerabook.site/story/story1')
  }
})
test('Telegram mock send, file id and unknown delivery handling', async () => {
  const message = buildPromotionMessage(options)
  const base = { token: '123:fake', chatId: '-10012345', message }
  const sent = await sendPromotionPhoto({ ...base, fileId: 'cached-file', fetchImpl: async (_, request) => {
    assert.equal(JSON.parse(request.body).photo, 'cached-file')
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 9, photo: [{ file_id: 'new-file' }] } }) }
  } })
  assert.equal(sent.messageId, 9)
  assert.equal(sent.fileId, 'new-file')
  await assert.rejects(sendPromotionPhoto({ ...base, fetchImpl: async () => { throw new Error('secret URL') } }), error => error.uncertain && !error.message.includes('secret'))
  await assert.rejects(sendPromotionPhoto({ ...base, fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ ok: false, error_code: 429, parameters: { retry_after: 42 } }) }) }), error => error.retryAfter === 42 && !error.uncertain)
})
