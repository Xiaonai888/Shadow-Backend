import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { subscribeAdminSupportNotification, publishAdminSupportNotificationChanged } from '../src/services/adminSupportNotificationSse.service.js'

class Response extends EventEmitter {
  chunks = []
  writableEnded = false
  destroyed = false
  blocked = false
  status(code) { this.statusCode = code; return this }
  set(headers) { this.headers = headers; return this }
  flushHeaders() {}
  write(data) { this.chunks.push(data); return !this.blocked }
  end() { this.writableEnded = true; this.emit('close') }
  destroy() { this.destroyed = true; this.emit('close') }
}

function connect(role, id) {
  const response = new Response()
  assert.equal(subscribeAdminSupportNotification({ role, admin_id: id }, response), true)
  return response
}

test('only authorized scopes receive invalidations; no message content', () => {
  const owner = connect('owner', 'owner')
  const admin = connect('admin', 'admin')
  const staff = connect('staff', 'assigned')
  const old = connect('staff', 'previous')
  const other = connect('staff', 'other')
  try {
    assert.equal(publishAdminSupportNotificationChanged({ assignedAdminId: 'assigned', previousAssignedAdminId: 'previous', message: 'private' }), 4)
    for (const response of [owner, admin, staff, old]) {
      assert.match(response.chunks[1], /support-notifications-changed/)
      assert.doesNotMatch(response.chunks.join(''), /private|assigned|previous/)
    }
    assert.equal(other.chunks.length, 1)
    assert.equal(publishAdminSupportNotificationChanged(), 2)
    assert.equal(staff.chunks.length, 2)
  } finally {
    for (const response of [owner, admin, staff, old, other]) response.end()
  }
  assert.equal(publishAdminSupportNotificationChanged(), 0)
})

test('limits each identity and releases closed connections', () => {
  const responses = Array.from({ length: 4 }, () => connect('owner', 'one'))
  try {
    assert.equal(subscribeAdminSupportNotification({ role: 'owner', admin_id: 'one' }, new Response()), false)
    assert.equal(subscribeAdminSupportNotification({ role: 'reader', admin_id: 'one' }, new Response()), false)
    responses[0].end()
    responses.push(connect('owner', 'one'))
  } finally {
    responses.forEach(response => response.end())
  }
})

test('backpressure disconnects slow client without unbounded buffering', () => {
  const response = connect('owner', 'slow')
  response.blocked = true
  assert.equal(publishAdminSupportNotificationChanged(), 0)
  assert.equal(response.destroyed, true)
  assert.equal(publishAdminSupportNotificationChanged(), 0)
})

test('global connection cap is enforced', () => {
  const responses = Array.from({ length: 32 }, (_, i) => connect('staff', `staff-${i}`))
  try {
    assert.equal(subscribeAdminSupportNotification({ role: 'owner', admin_id: 'extra' }, new Response()), false)
  } finally {
    responses.forEach(response => response.end())
  }
})
