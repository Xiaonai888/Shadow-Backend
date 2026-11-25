import test from 'node:test'
import assert from 'node:assert/strict'
import { supportImageActor, issueSupportImageToken, verifySupportImageToken, parseSupportImageCaption } from '../src/services/supportChatImageToken.service.js'
import { getSupportImageView } from '../src/services/supportChatImageMessages.service.js'
const reader = supportImageActor('reader', '11111111-1111-4111-8111-111111111111')
const admin = supportImageActor('admin', '22222222-2222-4222-8222-222222222222', 'staff')
const chat = '33333333-3333-4333-8333-333333333333'
const message = '44444444-4444-4444-8444-444444444444'
const upload = { key: 'support-chat-temp/55555555-5555-4555-8555-555555555555.webp', mime: 'image/webp', size: 1024 }
const mediaKey = 'support-chat-media/66666666-6666-4666-8666-666666666666.webp'
const opts = { secret: 'unit-test-secret', now: 1000, messageId: message }

test('token preserves server-selected message and object', () => {
  const { token } = issueSupportImageToken(reader, null, upload, opts)
  const result = verifySupportImageToken(token, reader, null, opts)
  assert.equal(result.messageId, message)
  assert.equal(result.key, upload.key)
})
test('token rejects account and conversation changes', () => {
  const { token } = issueSupportImageToken(admin, chat, upload, opts)
  assert.throws(() => verifySupportImageToken(token, reader, null, opts))
  assert.throws(() => verifySupportImageToken(token, admin, message, opts))
})
test('token rejects expired and tampered signatures', () => {
  const { token } = issueSupportImageToken(reader, null, upload, opts)
  assert.throws(() => verifySupportImageToken(token, reader, null, { ...opts, now: 721000 }))
  assert.throws(() => verifySupportImageToken(token.replace(/\.[^.]+$/, '.bad'), reader, null, opts))
})
test('invalid actor, upload and captions are rejected', () => {
  assert.throws(() => supportImageActor('admin', admin.id, 'unknown'))
  assert.throws(() => issueSupportImageToken(admin, null, upload, opts))
  assert.throws(() => issueSupportImageToken(reader, null, { ...upload, size: 2097153 }, opts))
  assert.throws(() => parseSupportImageCaption('x'.repeat(2001)))
  assert.equal(parseSupportImageCaption('  '), null)
})
function mockDb(rows, filters) {
  return { from(table) {
    const q = { select() { return q }, eq(k, v) { filters.push([table, k, v]); return q }, is(k, v) { filters.push([table, k, v]); return q }, async maybeSingle() { return { data: rows[table], error: null } } }
    return q
  } }
}
test('staff image view scopes assignment, conversation and non-deleted message', async () => {
  const filters = []
  const db = mockDb({ admin_support_conversations: { id: chat }, admin_support_messages: { id: message, attachments: [{ type: 'image', mime_type: 'image/webp', storage_key: mediaKey }] } }, filters)
  const out = await getSupportImageView(db, { getPrivateSupportImageReadUrl: key => ({ url: key }) }, admin, chat, message)
  assert.equal(out.url, mediaKey)
  assert.ok(filters.some(x => x[1] === 'assigned_admin_id' && x[2] === admin.id))
  assert.ok(filters.some(x => x[1] === 'conversation_id' && x[2] === chat))
  assert.ok(filters.some(x => x[1] === 'deleted_at' && x[2] === null))
})
test('reader without conversation cannot sign image URL', async () => {
  const db = mockDb({ admin_support_conversations: null }, [])
  await assert.rejects(getSupportImageView(db, {}, reader, null, message), { statusCode: 404 })
})
