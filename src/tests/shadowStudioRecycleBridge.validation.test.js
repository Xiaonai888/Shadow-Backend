import assert from 'node:assert/strict'
import test from 'node:test'
import { executeStudioRecycleAction } from '../services/shadowStudioRecycleBridge.service.js'

const ownerId = '75dbd0f8-01bd-4341-915a-12eb164ec921'
const videoId = '5a2f4c36-69fa-4b41-9b3a-5598d2f4e7c1'

function setup(payload = { ok: true, state: 'trashed' }) {
  const calls = []
  const invalidations = []
  const client = {
    rpc: async (name, args) => {
      calls.push({ name, args })
      return { data: payload, error: null }
    },
  }
  return { calls, invalidations, client, invalidate: id => invalidations.push(id) }
}

test('all supported Studio actions delegate to the same ownership-scoped RPC', async () => {
  for (const action of ['archive', 'unarchive', 'trash', 'restore', 'purge']) {
    const ctx = setup()
    const result = await executeStudioRecycleAction({ ownerId, videoId, action, client: ctx.client, invalidate: ctx.invalidate })
    assert.equal(result.ok, true)
    assert.deepEqual(ctx.calls, [{ name: 'shadow_studio_recycle_video', args: { p_owner: ownerId, p_video: videoId, p_action: action } }])
    assert.deepEqual(ctx.invalidations, [ownerId])
  }
})

test('invalid owner, video, and action never reach the database', async () => {
  const ctx = setup()
  for (const patch of [{ ownerId: '' }, { videoId: 'wrong' }, { action: 'delete-all' }]) {
    await assert.rejects(executeStudioRecycleAction({ ownerId, videoId, action: 'trash', client: ctx.client, invalidate: ctx.invalidate, ...patch }), { status: 400 })
  }
  assert.deepEqual(ctx.calls, [])
  assert.deepEqual(ctx.invalidations, [])
})

test('a rejected state transition never invalidates cached analytics', async () => {
  const ctx = setup({ ok: false, code: 'INVALID_STATE' })
  const result = await executeStudioRecycleAction({ ownerId, videoId, action: 'restore', client: ctx.client, invalidate: ctx.invalidate })
  assert.deepEqual(result, { ok: false, code: 'INVALID_STATE' })
  assert.deepEqual(ctx.invalidations, [])
})

test('database failures propagate and never claim a completed change', async () => {
  let invalidated = false
  await assert.rejects(executeStudioRecycleAction({
    ownerId, videoId, action: 'trash',
    client: { rpc: async () => ({ data: null, error: new Error('database unavailable') }) },
    invalidate: () => { invalidated = true },
  }), /database unavailable/)
  assert.equal(invalidated, false)
})

test('cache invalidation failure does not turn a committed database write into a failed write', async () => {
  const ctx = setup()
  const result = await executeStudioRecycleAction({ ownerId, videoId, action: 'trash', client: ctx.client, invalidate: () => { throw new Error('cache unavailable') } })
  assert.equal(result.ok, true)
  assert.equal(ctx.calls.length, 1)
})

test('malformed database payloads are rejected rather than reported as success', async () => {
  const ctx = setup(null)
  await assert.rejects(executeStudioRecycleAction({ ownerId, videoId, action: 'trash', client: ctx.client }), /Invalid Studio recycle response/)
})
