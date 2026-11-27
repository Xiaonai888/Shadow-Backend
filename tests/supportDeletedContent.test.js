import test from 'node:test'
import assert from 'node:assert/strict'
import { getDeletedSupportContent } from '../src/services/supportDeletedContent.service.js'

const chat = '12345678-1234-4234-8234-123456789abc'
const message = '12345678-1234-4234-8234-123456789abd'
const key = `support-chat-media/${message}.webp`
const time = Date.parse('2026-11-27T00:00:00Z')
const iso = value => new Date(value).toISOString()
const row = { conversation_id: chat, message_id: message, message_text: 'private text', deleted_at: iso(time - 86400000), expires_at: iso(time + 29 * 86400000), attachments: [{ type: 'image', storage_key: key, mime_type: 'image/webp' }] }
function setup({ data = row, role = 'owner', permissions = true, dbError, logError, clock = () => time } = {}) {
  const calls = [], logs = [], signed = []
  const chain = { select: columns => { calls.push(['select', columns]); return chain }, eq: (...args) => { calls.push(['eq', ...args]); return chain }, gt: (...args) => { calls.push(['gt', ...args]); return chain }, maybeSingle: async () => ({ data, error: dbError }) }
  const db = { from(name) { calls.push(['from', name]); if (name === 'admin_support_deleted_reader_content') return chain; assert.equal(name, 'admin_support_activity'); return { insert: async value => { logs.push(value); return { error: logError } } } } }
  const args = { db, signImage: value => { signed.push(value); return { url: 'https://example.invalid/private', expires_in_seconds: 120, key: value } }, admin: { role, admin_id: 'admin-1', has_all_permissions: permissions }, conversationId: chat, messageId: message, now: clock }
  return { args, calls, logs, signed }
}

test('owner can reveal retained content with scoped lookup and audit', async () => {
  const { args, calls, logs, signed } = setup()
  const result = await getDeletedSupportContent(args)
  assert.equal(result.message_text, 'private text')
  assert.deepEqual(signed, [key])
  assert.deepEqual(result.image, { url: 'https://example.invalid/private', expires_in_seconds: 120 })
  assert.ok(calls.some(c => c[0] === 'eq' && c[1] === 'conversation_id' && c[2] === chat))
  assert.ok(calls.some(c => c[0] === 'eq' && c[1] === 'message_id' && c[2] === message))
  assert.ok(calls.some(c => c[0] === 'gt' && c[1] === 'expires_at' && c[2] === iso(time)))
  assert.deepEqual(logs[0].details, { message_id: message })
  assert.equal(JSON.stringify(logs).includes('private text'), false)
})
test('admin with chat permission can reveal', async () => {
  const { args } = setup({ role: 'admin' })
  assert.equal((await getDeletedSupportContent(args)).ok, true)
})
test('staff, reader, and unauthorized admin rejected before lookup', async () => {
  for (const opts of [{ role: 'staff' }, { role: 'reader' }, { role: 'admin', permissions: false }]) {
    const { args, calls } = setup(opts)
    await assert.rejects(getDeletedSupportContent(args), { statusCode: 403 })
    assert.equal(calls.length, 0)
  }
})
test('invalid ID rejected before lookup', async () => {
  const { args, calls } = setup()
  await assert.rejects(getDeletedSupportContent({ ...args, messageId: 'bad' }), { statusCode: 400 })
  assert.equal(calls.length, 0)
})
test('missing, mismatched, expired and invalid expiry records fail closed', async () => {
  for (const data of [null, { ...row, conversation_id: message }, { ...row, message_id: chat }, { ...row, deleted_at: iso(time - 30 * 86400000), expires_at: iso(time) }, { ...row, expires_at: 'bad' }, { ...row, expires_at: iso(time + 31 * 86400000) }]) {
    const { args, logs, signed } = setup({ data })
    await assert.rejects(getDeletedSupportContent(args), { statusCode: 404 })
    assert.equal(logs.length, 0)
    assert.equal(signed.length, 0)
  }
})
test('invalid or legacy attachment never signed', async () => {
  const { args, signed } = setup({ data: { ...row, attachments: [{ type: 'image', storage_key: 'other/path', mime_type: 'image/webp' }, { type: 'image', storage_key: key }] } })
  const result = await getDeletedSupportContent(args)
  assert.equal(result.image, null)
  assert.equal(signed.length, 0)
})
test('image signing stops before retention boundary', async () => {
  const { args, signed } = setup({ data: { ...row, deleted_at: iso(time + 120000 - 30 * 86400000), expires_at: iso(time + 120000) } })
  const result = await getDeletedSupportContent(args)
  assert.equal(result.has_image, true)
  assert.equal(result.image, null)
  assert.equal(signed.length, 0)
})
test('audit failure denies reveal', async () => {
  const { args, signed } = setup({ logError: new Error('audit unavailable') })
  await assert.rejects(getDeletedSupportContent(args), /audit unavailable/)
  assert.equal(signed.length, 0)
})
test('database failure denies reveal', async () => {
  const { args, logs } = setup({ dbError: new Error('db unavailable') })
  await assert.rejects(getDeletedSupportContent(args), /db unavailable/)
  assert.equal(logs.length, 0)
})
test('expiry during audit denies reveal', async () => {
  let n = 0
  const { args, signed } = setup({ clock: () => ++n < 3 ? time : Date.parse(row.expires_at) })
  await assert.rejects(getDeletedSupportContent(args), { statusCode: 404 })
  assert.equal(signed.length, 0)
})
