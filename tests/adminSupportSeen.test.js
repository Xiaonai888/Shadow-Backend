import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSupportSeenInput, markSupportSeen, supportSeenError } from '../src/services/adminSupportSeen.service.js'

const actor = '12345678-1234-4234-8234-123456789abc'
const chat = '23456789-1234-4234-8234-123456789abc'
const message = '34567890-1234-4234-8234-123456789abc'
const body = { through_message_id: message }
const input = parseSupportSeenInput('admin', actor, chat, body)

test('admin uses verified conversation and actor', () => assert.deepEqual(input, { p_actor_kind: 'admin', p_actor_id: actor, p_conversation_id: chat, p_through_message_id: message }))
test('reader cannot supply conversation or actor overrides', () => assert.deepEqual(parseSupportSeenInput('reader', actor, chat, { ...body, actor_id: 'other', conversation_id: chat }), { p_actor_kind: 'reader', p_actor_id: actor, p_conversation_id: null, p_through_message_id: message }))
test('invalid message or conversation rejected', () => { assert.equal(parseSupportSeenInput('admin', actor, 'bad', body), null); assert.equal(parseSupportSeenInput('reader', actor, null, { through_message_id: [message] }), null) })
test('invalid actors rejected', () => { assert.equal(parseSupportSeenInput('reader', 'bad', null, body), null); assert.equal(parseSupportSeenInput('other', actor, chat, body), null); assert.equal(parseSupportSeenInput('admin', '', chat, body), null) })
test('changed receipt publishes scope but hides internal assignment from client', async () => {
  const events = []
  const db = { rpc: async (name, args) => { assert.equal(name, 'admin_support_mark_seen_v1'); assert.deepEqual(args, input); return { data: { ok: true, changed_count: 1, unread_count: 1, assigned_admin_id: actor } } } }
  const response = await markSupportSeen(db, input, event => events.push(event))
  assert.deepEqual(events, [{ assignedAdminId: actor }]); assert.equal(response.assigned_admin_id, undefined); assert.equal(response.unread_count, 1)
})
test('duplicate receipt does not emit event', async () => {
  const db = { rpc: async () => ({ data: { ok: true, changed_count: 0, unread_changed: false } }) }
  await markSupportSeen(db, input, () => assert.fail('duplicate event'))
})
test('successful receipt is not failed by stream error', async () => {
  const db = { rpc: async () => ({ data: { ok: true, changed_count: 1 } }) }
  assert.equal((await markSupportSeen(db, input, () => { throw new Error('stream') })).ok, true)
})
test('database failure is not published', async () => {
  await assert.rejects(markSupportSeen({ rpc: async () => ({ error: new Error('db') }) }, input, () => assert.fail('published')))
})
test('not found and unknown errors map safely', () => { assert.equal(supportSeenError(new Error('Support seen target not found')).status, 404); assert.equal(supportSeenError(new Error('db secret')).status, 503); assert.equal(supportSeenError(new Error('Invalid support seen input')).status, 400) })
