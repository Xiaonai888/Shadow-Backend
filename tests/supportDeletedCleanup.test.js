import test from 'node:test'
import assert from 'node:assert/strict'
import { runSupportDeletedCleanup, startSupportDeletedCleanup } from '../src/services/supportDeletedCleanup.service.js'

const KEY = 'support-chat-media/12345678-1234-4234-8234-123456789abc.webp'
const OTHER = 'support-chat-media/12345678-1234-4234-8234-123456789abd.png'

function fakeDb({ rows = [], cleanupError, claimError, acknowledgeError, counts = { migrated: 2, expired: 3 } } = {}) {
  const calls = []
  const ack = []
  const db = {
    async rpc(name, args) {
      calls.push([name, args])
      return name === 'cleanup_deleted_support_content_v1' ? { data: counts, error: cleanupError } : { data: rows, error: claimError }
    },
    from(name) {
      assert.equal(name, 'admin_support_deleted_media_queue')
      return { delete: () => ({ eq: async (column, key) => {
        assert.equal(column, 'storage_key')
        if (acknowledgeError) return { error: acknowledgeError }
        ack.push(key)
        return { error: null }
      } }) }
    },
  }
  return { db, calls, ack }
}

test('bounded cleanup and acknowledgement only after private image deletion', async () => {
  const { db, calls, ack } = fakeDb({ rows: [{ storage_key: KEY }] })
  const removed = []
  const result = await runSupportDeletedCleanup({ db, deleteImage: async (key, kind) => { assert.equal(kind, 'media'); assert.deepEqual(ack, []); removed.push(key) } })
  assert.deepEqual(result, { migrated: 2, expired: 3, removed: 1, failed: 0 })
  assert.deepEqual(calls, [['cleanup_deleted_support_content_v1', { p_limit: 100 }], ['claim_deleted_support_media_v1', { p_limit: 20 }]])
  assert.deepEqual(removed, [KEY])
  assert.deepEqual(ack, [KEY])
})

test('R2 failure retains queue and proceeds to next image', async () => {
  const { db, ack } = fakeDb({ rows: [{ storage_key: KEY }, { storage_key: OTHER }] })
  const result = await runSupportDeletedCleanup({ db, deleteImage: async key => { if (key === KEY) throw Error('failed') } })
  assert.equal(result.failed, 1)
  assert.equal(result.removed, 1)
  assert.deepEqual(ack, [OTHER])
})

test('rejects non-support and temp keys without touching storage', async () => {
  const { db, ack } = fakeDb({ rows: [{ storage_key: 'public/other.png' }, { storage_key: KEY.replace('media', 'temp') }] })
  const result = await runSupportDeletedCleanup({ db, deleteImage: async () => assert.fail('unexpected storage deletion') })
  assert.equal(result.failed, 2)
  assert.deepEqual(ack, [])
})

test('DB acknowledgement failure remains retryable', async () => {
  const { db, ack } = fakeDb({ rows: [{ storage_key: KEY }], acknowledgeError: Error('db') })
  const result = await runSupportDeletedCleanup({ db, deleteImage: async () => {} })
  assert.equal(result.failed, 1)
  assert.deepEqual(ack, [])
})

test('cleanup failure does not claim or delete images; next run can recover', async () => {
  const first = fakeDb({ cleanupError: Error('db') })
  await assert.rejects(runSupportDeletedCleanup({ db: first.db, deleteImage: async () => assert.fail() }))
  assert.equal(first.calls.length, 1)
  const second = fakeDb()
  assert.equal((await runSupportDeletedCleanup({ db: second.db, deleteImage: async () => assert.fail() })).failed, 0)
})

test('refuses unexpected RPC counts or excessive media batch', async () => {
  const first = fakeDb({ counts: { migrated: 101, expired: 0 } })
  await assert.rejects(runSupportDeletedCleanup({ db: first.db, deleteImage: async () => assert.fail() }))
  const second = fakeDb({ rows: Array.from({ length: 21 }, () => ({ storage_key: KEY })) })
  await assert.rejects(runSupportDeletedCleanup({ db: second.db, deleteImage: async () => assert.fail() }))
})

test('overlapping cleanup runs are skipped', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const { db } = fakeDb({ rows: [{ storage_key: KEY }] })
  const first = runSupportDeletedCleanup({ db, deleteImage: async () => gate })
  const second = await runSupportDeletedCleanup({ db, deleteImage: async () => assert.fail() })
  assert.deepEqual(second, { skipped: true })
  release()
  await first
})

test('disabled scheduler does not start', () => {
  assert.equal(startSupportDeletedCleanup({ enabled: false }), false)
})
