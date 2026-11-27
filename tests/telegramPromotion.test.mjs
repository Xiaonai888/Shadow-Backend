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
test('five languages: Update Today has original cover, bounded caption, bold title and four embedded links in two rows', () => {
  for (const language of ['Khmer', 'English', 'Chinese', 'Korean', 'Japanese']) {
    const message = buildPromotionMessage({ ...options, language, authorName: 'Dara', story: { ...story, story_language: language } })
    assert.ok(message.caption.length <= 1000)
    assert.equal(message.photo, story.cover_url)
    assert.deepEqual(message.reply_markup.inline_keyboard, [])
    const [bold, ...links] = message.caption_entities
    const visible = e => message.caption.slice(e.offset, e.offset + e.length)
    assert.equal(bold.type, 'bold')
    assert.equal(visible(bold), story.title)
    assert.equal(links.length, 4)
    assert.ok(links.every(e => e.type === 'text_link'))
    assert.deepEqual(links.map(e => e.url), ['https://www.shadowerabook.site/story/story1', 'https://www.shadowerabook.site/register', 'https://www.shadowerabook.site/install', 'https://youtu.be/gMUvBCkkPHQ?si=ZZKdPMcLuX6KzE2i'])
    assert.ok(message.caption.slice(0, links[0].offset).trimEnd().endsWith('...'))
    assert.equal(message.caption.slice(links[0].offset), `${visible(links[0])}  ${visible(links[1])}\n${visible(links[2])}  ${visible(links[3])}`)
    assert.ok(message.caption.includes('\n\n✍️ Dara\n\n'))
    assert.ok(!message.caption.includes('https://'))
    if (language === 'Khmer') assert.equal(message.caption.slice(links[0].offset), '📖 អានរឿងបន្ត  👤 បង្កើតគណនី\n📲 ដំឡើងកម្មវិធី  🎬 របៀបប្រើប្រាស់')
  }
})
test('optional promotions retain legacy caption and all four buttons in every language', () => {
  for (const language of ['Khmer', 'English', 'Chinese', 'Korean', 'Japanese']) {
    for (const kind of ['completed', 'short', 'trending', 'author']) {
      const m = buildPromotionMessage({ ...options, kind, language, story: { ...story, story_language: language }, authorName: 'Dara' })
      assert.ok(m.caption.length <= 1000)
      assert.ok(m.caption.endsWith('...'))
      assert.deepEqual(m.reply_markup.inline_keyboard.map(row => row.length), [1, 2, 1])
      assert.equal(m.reply_markup.inline_keyboard[0][0].url, 'https://www.shadowerabook.site/story/story1')
      assert.equal(m.caption_entities, undefined)
    }
  }
})
test('Update Today entities use UTF-16 offsets even for emoji and literal markup characters', () => {
  const title = '😀 A < B & C'
  const m = buildPromotionMessage({ ...options, story: { ...story, title }, authorName: 'A & B', content: '<p>😀 &amp; &lt;x&gt; abcdefghijklmnopqrstuvwxyz</p>'.repeat(50), links: { register: 'https://example.com/register?a=1&b=2' } })
  assert.equal(m.caption.slice(m.caption_entities[0].offset, m.caption_entities[0].offset + m.caption_entities[0].length), title)
  assert.equal(m.caption_entities[2].url, 'https://example.com/register?a=1&b=2')
  assert.equal(m.caption.slice(m.caption_entities[2].offset, m.caption_entities[2].offset + m.caption_entities[2].length), '👤 បង្កើតគណនី')
  assert.ok(m.caption.length <= 1000)
})
test('Telegram wire payload omits buttons only for entity-based Update Today', async () => {
  for (const kind of ['update', 'completed', 'short', 'trending', 'author']) {
    const message = buildPromotionMessage({ ...options, kind })
    await sendPromotionPhoto({ token: '123:fake', chatId: '-10012345', message, fetchImpl: async (_, request) => {
      const payload = JSON.parse(request.body)
      assert.equal(payload.caption, message.caption)
      assert.equal(payload.parse_mode, undefined)
      if (kind === 'update') {
        assert.equal(payload.reply_markup, undefined)
        assert.deepEqual(payload.caption_entities, message.caption_entities)
      } else {
        assert.deepEqual(payload.reply_markup, message.reply_markup)
        assert.equal(payload.caption_entities, undefined)
      }
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }
    } })
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
