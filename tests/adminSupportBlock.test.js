import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSupportBlockInput, supportBlockError, getAdminSupportBlock, getReaderSupportBlock, setAdminSupportBlock } from '../src/services/adminSupportBlock.service.js'

const id = '11111111-1111-4111-8111-111111111111'
const owner = { role: 'owner', admin_id: 'owner-1' }
const staff = { role: 'staff', admin_id: 'staff-1' }

function mockQuery(data, error = null) {
  const calls = []
  const query = { select(fields) { calls.push(['select', fields]); return this }, eq(key, value) { calls.push([key, value]); return this }, async maybeSingle() { return { data, error } } }
  return { calls, db: { from(table) { calls.push(['table', table]); return query } } }
}

test('owner can block or unblock', () => {
  for (const blocked of [true, false]) assert.deepEqual(parseSupportBlockInput(owner, id, { blocked }), { p_conversation_id: id, p_admin_id: 'owner-1', p_blocked: blocked })
})
test('admin, staff and missing roles cannot block', () => {
  for (const role of ['admin', 'staff', 'reader', undefined]) assert.equal(parseSupportBlockInput({ ...owner, role }, id, { blocked: true }), null)
})
test('rejects malformed input and string booleans', () => {
  for (const body of [null, [], {}, { blocked: 'false' }, { blocked: 1 }]) assert.equal(parseSupportBlockInput(owner, id, body), null)
  assert.equal(parseSupportBlockInput(owner, 'bad', { blocked: true }), null)
  assert.equal(parseSupportBlockInput({ ...owner, admin_id: '' }, id, { blocked: true }), null)
})
test('staff read is scoped to assignment', async () => {
  const { db, calls } = mockQuery({ id, support_blocked_at: '2026-11-25T10:00:00Z' })
  assert.deepEqual(await getAdminSupportBlock(db, staff, id), { ok: true, conversation_id: id, blocked: true })
  assert.ok(calls.some(([key, value]) => key === 'assigned_admin_id' && value === 'staff-1'))
})
test('owner status does not filter staff assignment', async () => {
  const { db, calls } = mockQuery({ id, support_blocked_at: null })
  assert.equal((await getAdminSupportBlock(db, owner, id)).blocked, false)
  assert.ok(!calls.some(([key]) => key === 'assigned_admin_id'))
})
test('reader sees only own status without owner identity', async () => {
  const { db, calls } = mockQuery({ support_blocked_at: '2026-11-25T10:00:00Z' })
  assert.deepEqual(await getReaderSupportBlock(db, id), { ok: true, blocked: true })
  assert.ok(calls.some(([key, value]) => key === 'reader_user_id' && value === id))
})
test('no reader conversation is not blocked', async () => {
  assert.deepEqual(await getReaderSupportBlock(mockQuery(null).db, id), { ok: true, blocked: false })
})
test('missing admin conversation rejects', async () => {
  await assert.rejects(getAdminSupportBlock(mockQuery(null).db, staff, id), /not found/)
})
test('RPC receives verified actor and boolean', async () => {
  const input = parseSupportBlockInput(owner, id, { blocked: true })
  const db = { rpc: async (name, args) => { assert.equal(name, 'admin_support_set_block_v1'); assert.deepEqual(args, input); return { data: { ok: true, blocked: true, changed: true }, error: null } } }
  assert.equal((await setAdminSupportBlock(db, input)).blocked, true)
})
test('RPC errors propagate and public errors are safe', async () => {
  const error = new Error('Support block owner required')
  await assert.rejects(setAdminSupportBlock({ rpc: async () => ({ error }) }, {}), /owner required/)
  assert.equal(supportBlockError(error).status, 403)
  assert.equal(supportBlockError(new Error('Support conversation not found')).status, 404)
  assert.equal(supportBlockError(new Error('internal secret')).status, 503)
  assert.ok(!supportBlockError(new Error('internal secret')).message.includes('secret'))
})
