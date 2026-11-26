import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSupportPinInput, supportPinError, runSupportPin } from '../src/services/supportChatPins.service.js'

const reader = '123e4567-e89b-42d3-a456-426614174000'
const chat = '123e4567-e89b-42d3-a456-426614174001'
const message = '123e4567-e89b-42d3-a456-426614174002'

test('reader cannot supply a different conversation ID', () => {
  assert.deepEqual(parseSupportPinInput('reader', reader, chat, 'pin', message), { p_actor_kind: 'reader', p_actor_id: reader, p_conversation_id: null, p_action: 'pin', p_message_id: message })
})
test('admin requires conversation ID', () => {
  assert.equal(parseSupportPinInput('admin', 'staff-1', null, 'list'), null)
  assert.equal(parseSupportPinInput('admin', 'staff-1', chat, 'list').p_conversation_id, chat)
})
test('invalid actors, actions and message IDs rejected', () => {
  assert.equal(parseSupportPinInput('guest', reader, chat, 'list'), null)
  assert.equal(parseSupportPinInput('reader', 'invalid', chat, 'list'), null)
  assert.equal(parseSupportPinInput('reader', reader, chat, 'forward', message), null)
  assert.equal(parseSupportPinInput('reader', reader, chat, 'unpin', 'bad'), null)
})
test('list ignores client message ID', () => {
  assert.equal(parseSupportPinInput('reader', reader, chat, 'list', message).p_message_id, null)
})
test('known failure codes map correctly; unknown errors are masked', () => {
  assert.equal(supportPinError(new Error('SUPPORT_CHAT_BLOCKED')).status, 403)
  assert.equal(supportPinError(new Error('SUPPORT_PIN_NOT_FOUND')).status, 404)
  assert.equal(supportPinError(new Error('SUPPORT_PIN_LIMIT')).status, 409)
  assert.deepEqual(supportPinError(new Error('private details')), { status: 503, code: 'SUPPORT_PIN_UNAVAILABLE' })
})
test('one RPC returns bounded result', async () => {
  const input = parseSupportPinInput('reader', reader, null, 'list')
  let calls = 0
  const db = { rpc: async (name, args) => { calls++; assert.equal(name, 'admin_support_pins_v1'); assert.deepEqual(args, input); return { data: { ok: true, pins: [], limit: 50 } } } }
  assert.equal((await runSupportPin(db, input)).limit, 50)
  assert.equal(calls, 1)
})
test('RPC error or malformed response is not treated as success', async () => {
  await assert.rejects(runSupportPin({ rpc: async () => ({ error: new Error('offline') }) }, {}), /offline/)
  await assert.rejects(runSupportPin({ rpc: async () => ({ data: { ok: true, pins: Array(51) } }) }, {}), /Invalid support pin response/)
})
