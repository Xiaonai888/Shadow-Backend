import test from 'node:test'
import assert from 'node:assert/strict'
import { createPromotionWorker } from '../src/services/telegramPromotion/worker.service.js'
import { createPromotionCandidates } from '../src/services/telegramPromotion/candidates.service.js'

const job = { id: 'job', language: 'km', kind: 'update', telegram_chat_id: '-10012345', payload: { photo: 'https://example.com/cover.jpg' } }
const settings = { enabled: true, language: 'km', channel_id: '-10012345' }
function fixture({ send, validate = async () => ({ eligible: true }), fileId = null, finishOk = true, token = '123:abc' } = {}) {
  const calls = []
  const queue = { claim: async () => job, finish: async (j, state, options) => { calls.push([state, options]); return finishOk }, getFileId: async () => fileId, saveFileId: async (...args) => calls.push(['cache', args.at(-1)]), removeFileId: async () => calls.push(['remove']) }
  const worker = createPromotionWorker({ queue, candidates: { validate }, token, send: send || (async () => ({ messageId: 1, fileId: 'photo' })) })
  return { worker, calls }
}
test('sent and cache saved', async () => { const { worker, calls } = fixture(); assert.equal((await worker.run(settings)).state, 'sent'); assert.deepEqual(calls.map(c => c[0]), ['sent', 'cache']) })
test('invalid token prevents work', async () => { const { worker, calls } = fixture({ token: '' }); assert.equal((await worker.run(settings)).state, 'disabled'); assert.equal(calls.length, 0) })
test('hidden story cancelled', async () => { const { worker, calls } = fixture({ validate: async () => ({ eligible: false, reason: 'not_public' }) }); assert.equal((await worker.run(settings)).state, 'cancelled'); assert.equal(calls[0][1].error, 'not_public') })
test('validation failure retries safely', async () => { const { worker } = fixture({ validate: async () => { throw Error('db') } }); assert.equal((await worker.run(settings)).state, 'retry') })
test('unknown send result never retries automatically', async () => { const { worker } = fixture({ send: async () => { throw Object.assign(Error('timeout'), { uncertain: true }) } }); assert.equal((await worker.run(settings)).state, 'uncertain') })
test('rate limit obeys Telegram delay', async () => { const { worker, calls } = fixture({ send: async () => { throw Object.assign(Error('429'), { status: 429, retryAfter: 601 }) } }); assert.equal((await worker.run(settings)).state, 'retry'); assert.equal(calls[0][1].retrySeconds, 601) })
test('rejected cached photo falls back to URL once', async () => { let tries=0; const {worker,calls}=fixture({fileId:'old',send:async ({fileId})=>{tries++; if(fileId) throw Object.assign(Error('400'),{status:400}); return {messageId:2}}}); assert.equal((await worker.run(settings)).state,'sent'); assert.equal(tries,2); assert.equal(calls[0][0],'remove') })
test('failure recording success does not resend', async () => { let tries=0; const {worker}=fixture({finishOk:false,send:async()=>{tries++;return {messageId:3}}}); await assert.rejects(worker.run(settings), /lease lost/); assert.equal(tries,1) })
test('missing visible context blocks job', async () => { const c=createPromotionCandidates({rpc:async()=>({data:null})},{load:async()=>({})}); assert.deepEqual(await c.validate(job),{eligible:false,reason:'not_public'}) })
