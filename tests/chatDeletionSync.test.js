import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { CHAT_DELETION_SYNC_LIMIT, parseDeletionSyncIds, readChatDeletionSync } from '../src/services/chatDeletionSync.service.js'

const chat = randomUUID()
const a = randomUUID(), b = randomUUID(), c = randomUUID()
const stamp = '2026-11-27T00:00:00.000Z'
function setup(rows = [], error = null) {
  const calls = []
  const chain = { select: (...x) => { calls.push(['select', ...x]); return chain }, eq: (...x) => { calls.push(['eq', ...x]); return chain }, in: (...x) => { calls.push(['in', ...x]); return chain }, gt: (...x) => { calls.push(['gt', ...x]); return chain }, limit: async (...x) => { calls.push(['limit', ...x]); return { data: rows, error } } }
  const db = { from: name => { calls.push(['from', name]); return chain } }
  return { calls, args: { db, table: 'chat_messages', conversationId: chat, rawIds: [a,b,c].join(',') } }
}
test('bounded IDs, canonicalization and deduplication', () => {
  assert.deepEqual(parseDeletionSyncIds(`${a.toUpperCase()},${a},${b}`), [a,b])
  assert.equal(parseDeletionSyncIds(Array.from({length: CHAT_DELETION_SYNC_LIMIT}, randomUUID).join(',')).length, 40)
  assert.deepEqual(parseDeletionSyncIds(Array.from({length: 41}, randomUUID).join(',')), [])
})
test('invalid, omitted or oversized IDs do not query', async () => {
  for (const rawIds of [undefined, '', ['a'], `${a},invalid`, a.repeat(100)]) {
    const { args, calls } = setup()
    assert.equal(await readChatDeletionSync({...args, rawIds}), null)
    assert.equal(calls.length, 0)
  }
})
test('reports only deleted and missing IDs, not active content', async () => {
  const { args, calls } = setup([{id:a,deleted_at:null,body:'private'}, {id:b,deleted_at:stamp,body:'deleted secret'}])
  assert.deepEqual(await readChatDeletionSync(args), {checked_ids:[a,b,c], removed:[{id:b,deleted_at:stamp},{id:c,deleted_at:null}]})
  assert.deepEqual(calls,[['from','chat_messages'],['select','id, deleted_at'],['eq','conversation_id',chat],['in','id',[a,b,c]],['limit',40]])
})
test('supports scoped support-chat query without content', async () => {
  const { args, calls } = setup([{id:a,deleted_at:stamp}])
  const result = await readChatDeletionSync({...args,table:'admin_support_messages',rawIds:a})
  assert.deepEqual(result.removed,[{id:a,deleted_at:stamp}])
  assert.equal(calls[0][1], 'admin_support_messages')
  assert.equal(calls[1][1], 'id, deleted_at')
})
test('respects ordinary-chat visibility cutoff', async () => {
  const { args, calls } = setup([])
  await readChatDeletionSync({...args,visibilityCutoff:stamp})
  assert.ok(calls.some(x=>x[0]==='gt'&&x[1]==='created_at'&&x[2]===stamp))
})
test('invalid scope fails before querying', async () => {
  const { args, calls } = setup()
  await assert.rejects(readChatDeletionSync({...args,table:'users'}))
  await assert.rejects(readChatDeletionSync({...args,conversationId:'invalid'}))
  assert.equal(calls.length,0)
})
test('database failures do not pretend IDs were removed', async () => {
  const {args} = setup([], new Error('database unavailable'))
  await assert.rejects(readChatDeletionSync(args), /database unavailable/)
})
test('unexpected, duplicate or malformed rows fail closed', async () => {
  for (const rows of [[{id:randomUUID(),deleted_at:null}],[{id:a,deleted_at:null},{id:a,deleted_at:null}],[{id:a,deleted_at:'invalid'}],null]) {
    const {args}=setup(rows)
    await assert.rejects(readChatDeletionSync(args))
  }
})
