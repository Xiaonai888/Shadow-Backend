import { test } from 'node:test'
import assert from 'node:assert/strict'
import { notifyReaderSupportMessage, notifyAdminSupportConversationAction } from '../src/services/adminSupportNotificationEvents.service.js'

const conversationId = '00000000-0000-4000-8000-000000000001'
const readerId = '00000000-0000-4000-8000-000000000002'
const result = { ok: true, created: true, conversation_id: conversationId }

function database(response) {
  const calls = []
  const query = {
    select(...args) { calls.push(['select', ...args]); return this },
    eq(...args) { calls.push(['eq', ...args]); return this },
    abortSignal(signal) { assert.ok(signal instanceof AbortSignal); return this },
    async maybeSingle() { if (response instanceof Error) throw response; return response },
  }
  return { calls, from(table) { calls.push(['from', table]); return query } }
}

function recorder() {
  const calls = []
  return { calls, publish(scope) { calls.push(scope); return 1 } }
}

test('reader send publishes only assigned scope after successful creation', async () => {
  const db = database({ data: { assigned_admin_id: 'staff-a' }, error: null })
  const rec = recorder()
  assert.equal(await notifyReaderSupportMessage(db, { ...result, message: { message_text: 'private' } }, readerId, rec), 1)
  assert.deepEqual(rec.calls, [{ assignedAdminId: 'staff-a' }])
  assert.deepEqual(db.calls, [['from', 'admin_support_conversations'], ['select', 'assigned_admin_id'], ['eq', 'id', conversationId], ['eq', 'reader_user_id', readerId]])
})

test('failed sends, duplicates and invalid identifiers do not query or publish', async () => {
  const db = database({})
  const rec = recorder()
  for (const input of [{ ...result, ok: false }, { ...result, created: false }, { ...result, conversation_id: 'bad' }]) {
    assert.equal(await notifyReaderSupportMessage(db, input, readerId, rec), 0)
  }
  assert.equal(await notifyReaderSupportMessage(db, result, 'bad', rec), 0)
  assert.deepEqual(db.calls, [])
  assert.deepEqual(rec.calls, [])
})

test('failed scope lookup invalidates owner/admin only without failing send', async () => {
  for (const response of [new Error('offline'), { error: { code: 'TIMEOUT' } }, { data: null }]) {
    const rec = recorder()
    assert.equal(await notifyReaderSupportMessage(database(response), result, readerId, rec), 1)
    assert.deepEqual(rec.calls, [{ assignedAdminId: null }])
  }
})

test('read, archive, restore invalidate current assignment', () => {
  const conversation = { id: conversationId, assigned_admin_id: 'staff-a' }
  for (const action of ['read', 'archive', 'restore']) {
    const rec = recorder()
    assert.equal(notifyAdminSupportConversationAction({ ok: true, conversation_id: conversationId, action }, conversation, { action }, rec), 1)
    assert.deepEqual(rec.calls, [{ assignedAdminId: 'staff-a', previousAssignedAdminId: 'staff-a' }])
  }
})

test('transfer and unassign invalidate old and new staff scopes', () => {
  const conversation = { id: conversationId, assigned_admin_id: 'staff-a' }
  const input = { ok: true, conversation_id: conversationId, action: 'assign' }
  const rec = recorder()
  notifyAdminSupportConversationAction(input, conversation, { action: 'assign', value: ' staff-b ' }, rec)
  notifyAdminSupportConversationAction(input, conversation, { action: 'assign', value: null }, rec)
  assert.deepEqual(rec.calls, [{ assignedAdminId: 'staff-b', previousAssignedAdminId: 'staff-a' }, { assignedAdminId: null, previousAssignedAdminId: 'staff-a' }])
})

test('irrelevant, mismatched and failed actions do not publish', () => {
  const conversation = { id: conversationId }
  const rec = recorder()
  for (const action of ['note', 'priority', 'country']) {
    assert.equal(notifyAdminSupportConversationAction({ ok: true, conversation_id: conversationId, action }, conversation, { action }, rec), 0)
  }
  assert.equal(notifyAdminSupportConversationAction({ ok: true, conversation_id: 'other', action: 'read' }, conversation, { action: 'read' }, rec), 0)
  assert.equal(notifyAdminSupportConversationAction({ ok: false, conversation_id: conversationId, action: 'read' }, conversation, { action: 'read' }, rec), 0)
  assert.deepEqual(rec.calls, [])
})

test('publish errors do not change successful mutation result', async () => {
  const options = { publish() { throw new Error('disconnected') } }
  assert.equal(await notifyReaderSupportMessage(database({ data: null }), result, readerId, options), 0)
  assert.equal(notifyAdminSupportConversationAction({ ok: true, conversation_id: conversationId, action: 'read' }, { id: conversationId }, { action: 'read' }, options), 0)
})
