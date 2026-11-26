import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getSupportNotificationCount, getSupportNotifications, parseSupportNotificationPage, parseSupportNotificationFilter } from '../src/services/adminSupportNotification.service.js'

function database(responses) {
  const calls = []
  return { calls, from(table) {
    const response = responses[table]
    const query = { then(resolve, reject) { return Promise.resolve(response).then(resolve, reject) } }
    for (const method of ['select', 'neq', 'gt', 'eq', 'order', 'range', 'in', 'limit', 'not']) {
      query[method] = (...args) => { calls.push([table, method, ...args]); return query }
    }
    return query
  } }
}

const owner = { role: 'owner', admin_id: 'owner-a' }
const staff = { role: 'staff', admin_id: 'staff-a' }
const table = 'admin_support_conversations'

test('invalid page parameters rejected and default page accepted', () => {
  assert.equal(parseSupportNotificationPage(undefined), 1)
  assert.equal(parseSupportNotificationPage('10000'), 10000)
  for (const value of ['0', '-1', '1.5', '10001', '', [], 1, null]) assert.equal(parseSupportNotificationPage(value), null)
})

test('count uses exact database count and staff assignment scope', async () => {
  const db = database({ [table]: { count: 27, error: null } })
  assert.equal(await getSupportNotificationCount(db, staff), 27)
  assert.deepEqual(db.calls, [[table, 'select', 'id', { count: 'exact', head: true }], [table, 'neq', 'status', 'archived'], [table, 'gt', 'unread_for_admin', 0], [table, 'eq', 'assigned_admin_id', 'staff-a']])
})

test('list bounds data to ten rows and one profile lookup', async () => {
  const rows = Array.from({ length: 11 }, (_, i) => ({ id: `chat-${i}`, reader_user_id: `reader-${i}`, unread_for_admin: i + 1, created_at: '2026-11-25T00:00:00Z' }))
  const db = database({ [table]: { data: rows }, users: { data: [{ id: 'reader-0', name: 'Reader' }] } })
  const data = await getSupportNotifications(db, owner, 2)
  assert.equal(data.notifications.length, 10)
  assert.equal(data.next_page, 3)
  assert.equal(data.notifications[0].reader.name, 'Reader')
  assert.equal(data.notifications[0].unread_count, 1)
  assert.equal(data.notifications[0].type, 'support_message')
  assert.deepEqual(db.calls.find(call => call[1] === 'range'), [table, 'range', 10, 20])
  assert.deepEqual(db.calls.find(call => call[1] === 'in'), ['users', 'in', 'id', rows.slice(0, 10).map(row => row.reader_user_id)])
  assert.equal(db.calls.some(call => call[1] === 'eq' && call[2] === 'assigned_admin_id'), false)
})

test('empty page does not query users; invalid scope rejected', async () => {
  const db = database({ [table]: { data: [] } })
  const data = await getSupportNotifications(db, staff, 1)
  assert.deepEqual(data.notifications, [])
  assert.equal(data.next_page, null)
  assert.equal(db.calls.some(call => call[0] === 'users'), false)
  await assert.rejects(getSupportNotificationCount(db, { role: 'reader', admin_id: 'r' }), /Invalid admin scope/)
  await assert.rejects(getSupportNotifications(db, owner, 10001), /Invalid page/)
})

test('database failures do not produce misleading zero count', async () => {
  const db = database({ [table]: { error: new Error('offline') } })
  await assert.rejects(getSupportNotificationCount(db, owner), /offline/)
  await assert.rejects(getSupportNotifications(db, owner, 1), /offline/)
})


test('history includes read conversations and remains scoped to staff', async () => {
  const db = database({ [table]: { data: [{ id: 'chat-1', reader_user_id: 'r', unread_for_admin: 0, last_reader_message_at: '2026-11-25T00:00:00Z', last_message_at: '2026-11-26T00:00:00Z' }] }, users: { data: [] } })
  const data = await getSupportNotifications(db, staff, 1, 'all')
  assert.equal(data.notifications[0].is_read, true)
  assert.equal(data.notifications[0].last_activity_at, '2026-11-25T00:00:00Z')
  assert.ok(db.calls.some(c => c[1] === 'not' && c[2] === 'last_reader_message_at'))
  assert.ok(db.calls.some(c => c[1] === 'eq' && c[3] === 'staff-a'))
  assert.ok(!db.calls.some(c => c[1] === 'gt'))
})

test('filter validation rejects non-string and unknown filters', () => {
  assert.equal(parseSupportNotificationFilter(undefined), 'unread')
  assert.equal(parseSupportNotificationFilter('all'), 'all')
  for (const input of [[], null, 'invalid', 1]) assert.equal(parseSupportNotificationFilter(input), null)
})
