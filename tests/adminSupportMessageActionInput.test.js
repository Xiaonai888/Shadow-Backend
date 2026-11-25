import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSupportMessageAction, isSupportMessageId, supportMessageActionError } from '../src/services/adminSupportMessageActionInput.service.js'

const conversationId = '10000000-0000-4000-8000-000000000001'
const messageId = '10000000-0000-4000-8000-000000000002'
const requestId = '10000000-0000-4000-8000-000000000003'
const params = { conversationId, messageId }

test('validates IDs and rejects coercion', () => {
  assert.equal(isSupportMessageId(messageId), true)
  assert.equal(isSupportMessageId([messageId]), false)
  assert.equal(parseSupportMessageAction({ ...params, messageId: 'bad' }, {}, 'delete'), null)
})
test('edit preserves internal line breaks', () => {
  assert.equal(parseSupportMessageAction(params, { message: ' a\nb ' }, 'edit').text, 'a\nb')
})
test('edit rejects invalid text and action', () => {
  for (const message of ['', '   ', 1, 'x'.repeat(2001)]) assert.equal(parseSupportMessageAction(params, { message }, 'edit'), null)
  assert.equal(parseSupportMessageAction(params, {}, 'unknown'), null)
})
test('delete requires no request body', () => {
  assert.deepEqual(parseSupportMessageAction(params, undefined, 'delete'), { ...params, action: 'delete' })
})
test('reply preserves client request ID for retry', () => {
  assert.equal(parseSupportMessageAction(params, { message: 'Hello', request_id: requestId }, 'reply').requestId, requestId)
})
test('reply rejects invalid or target request ID', () => {
  for (const request_id of [null, '', messageId, [requestId]]) assert.equal(parseSupportMessageAction(params, { message: 'Hello', request_id }, 'reply'), null)
})
test('reply creates an ID if not supplied', () => {
  assert.equal(isSupportMessageId(parseSupportMessageAction(params, { message: 'Hello' }, 'reply').requestId), true)
})
test('maps known errors without exposing raw details', () => {
  assert.equal(supportMessageActionError({ message: 'Staff is not assigned to this conversation' }).status, 404)
  assert.equal(supportMessageActionError({ message: 'Archived support chat is read only' }).status, 409)
  assert.equal(supportMessageActionError({ message: 'Invalid support reply' }).status, 400)
  assert.equal(supportMessageActionError({ message: 'secret internal error' }).status, 503)
})
