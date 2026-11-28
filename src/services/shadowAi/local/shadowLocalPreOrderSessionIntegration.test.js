import test from 'node:test'
import assert from 'node:assert/strict'
import { createShadowLocalRuntimeDb } from './shadowLocalRuntimeDb.service.js'
import { createShadowPreOrderBooking } from '../shadowAiPreOrderBooking.service.js'
import { createShadowAiPreOrderSession } from '../shadowAiPreOrderSession.service.js'

const scope = { actorUserId: '11111111-1111-4111-8111-111111111111', authorPageId: '22222222-2222-4222-8222-222222222222', campaignId: '33333333-3333-4333-8333-333333333333', conversationId: '44444444-4444-4444-8444-444444444444' }
const bookId = '55555555-5555-4555-8555-555555555555'
function fixture({ legacy = false, denyFinal = false, denyQuota = false, failSave = false, failFinish = false } = {}) {
  const calls = [], context = { author_page_id: scope.authorPageId, campaign_id: scope.campaignId, can_book: true, stock_verified: true, books: [{ id: bookId, title: 'Moon', editions: [{ edition: 'standard', price_usd: 5, available: 2 }, { edition: 'limited', price_usd: 10, available: 1 }] }], delivery_companies: [{ company_key: 'courier', company_name: 'Courier' }], signature_enabled: false }
  let stored = { draft: {}, revision: null, expires_at: null }, clock = 10000
  const db = { rpc(name, args) { calls.push(name); return { async abortSignal() {
    if (name === 'shadow_ai_reserve_request_v1') return { data: denyQuota ? { ok: false, code: 'SHADOW_AI_DAILY_LIMIT' } : { ok: true, request_id: args.p_request_id } }
    if (name === 'shadow_ai_finish_request_v1') return { data: !failFinish }
    if (name === 'shadow_ai_local_knowledge_read_v1') return { data: { version: 1, aliases: [] } }
    throw Error('Unexpected RPC')
  } } } }
  const instance = createShadowLocalRuntimeDb({ db, env: { SHADOW_AI_ENABLED: 'true' }, now: () => clock })
  const contextService = { async detail(a,c) { calls.push('context'); assert.equal(a,scope.authorPageId); assert.equal(c,scope.campaignId); return context } }
  const loadConfirmedRules = async () => { calls.push('rules'); return { confirmed: true, rules: [] } }
  const bridge = legacy ? null : instance.preOrderBridge
  const bookingTurn = createShadowPreOrderBooking({ contextService, runAi: instance.runShadowAi, loadConfirmedRules, preOrderBridge: bridge })
  const session = createShadowAiPreOrderSession({ contextService, loadConfirmedRules, bookingTurn, commitTurn: bridge?.commitTurn ?? null, authorizeInitial: async () => { calls.push('initial'); return true }, authorize: async () => { calls.push('final'); return !denyFinal }, draftStore: { async load() { calls.push('load'); return structuredClone(stored) }, async save(s, rev, draft) { calls.push('save'); assert.equal(rev,stored.revision); if (failSave) throw Object.assign(new Error('Conflict'), {code:'SHADOW_AI_DRAFT_CONFLICT'}); stored = { draft: structuredClone(draft), revision: (rev ?? 0)+1, expires_at: '2026-12-01T00:00:00Z' }; return { revision: stored.revision, expires_at: stored.expires_at } } }, checkoutReview: async () => ({ checked: true }) })
  return { session, bridge, context, calls, advance: ms => { clock += ms }, message: (message, extra = {}) => session.message({ ...scope, message, revision: stored.revision, ...extra }) }
}
const flags = turn => [turn.order_created,turn.payment_created,turn.inventory_reserved]
test('question returns the same live context and uses no second context read',async()=>{ const f=fixture(); const t=await f.message('price',{locale:'en'}); assert.equal(t.question,'price');assert.deepEqual(t.context,f.context);assert.deepEqual(t.rules,[]);assert.equal(t.reply.language,'en');assert.deepEqual(flags(t),[false,false,false]);assert.equal(f.calls.filter(x=>x==='context').length,1);assert.equal(f.calls.includes('save'),false);assert.equal(f.calls.at(-1),'final') })
test('session commits memory after permission and warm dictionary uses no additional read',async()=>{const f=fixture();await f.message('price'); const t=await f.message('repeat the last answer');assert.equal(t.question,'price');assert.equal(f.calls.filter(x=>x.includes('knowledge_read')).length,1);assert.equal(f.calls.filter(x=>x.includes('reserve_request')).length,2);assert.equal(f.calls.filter(x=>x.includes('finish_request')).length,2);assert.equal(f.bridge.learningSnapshot().counts.handled,2)})
test('memory cannot cross conversation',async()=>{const f=fixture();await f.message('price');assert.equal((await f.message('repeat the last answer',{conversationId:bookId})).intent,'unclear')})
test('memory expires after ten minutes',async()=>{const f=fixture();await f.message('price');f.advance(600000);assert.equal((await f.message('repeat the last answer')).intent,'unclear')})
test('booking writes draft before committing observation, matches legacy output',async()=>{const f=fixture(),old=fixture({legacy:true});const a=await f.message('book: Moon\nedition: limited\nquantity: 2'),b=await old.message('book: Moon\nedition: limited\nquantity: 2');const {reply,...base}=a;assert.deepEqual(base,b);assert.equal(a.intent,'booking');assert.equal(a.validation.ready,false);assert.ok(a.validation.issues.some(x=>x.startsWith('STOCK_UNAVAILABLE')));assert.deepEqual(flags(a),[false,false,false]);assert.deepEqual(f.calls.slice(-2),['final','save']);assert.equal(a.revision,1)})
test('permission denied at final check never commits or saves',async()=>{const f=fixture({denyFinal:true});await assert.rejects(f.message('price'),{code:'SHADOW_AI_SESSION_DENIED'});assert.equal(f.bridge.learningSnapshot().counts.handled,0);assert.equal(f.calls.includes('save'),false)})
test('draft conflict never commits observation',async()=>{const f=fixture({failSave:true});await assert.rejects(f.message('book: Moon'),{code:'SHADOW_AI_DRAFT_CONFLICT'});assert.ok(Object.values(f.bridge.learningSnapshot().counts).every(x=>x===0))})
test('stale revision stops before context or quota',async()=>{const f=fixture();await assert.rejects(f.message('price',{revision:123}),{code:'SHADOW_AI_DRAFT_CONFLICT'});assert.deepEqual(f.calls,['initial','load'])})
test('quota refusal does not read knowledge or commit',async()=>{const f=fixture({denyQuota:true});await assert.rejects(f.message('price'),{code:'SHADOW_AI_DAILY_LIMIT'});assert.equal(f.calls.some(x=>x.includes('knowledge_read')),false);assert.equal(f.bridge.learningSnapshot().counts.handled,0)})
test('finish failure never commits memory',async()=>{const f=fixture({failFinish:true});await assert.rejects(f.message('price'),{code:'SHADOW_AI_USAGE_UNAVAILABLE'});assert.equal(f.bridge.learningSnapshot().counts.handled,0);assert.equal(f.calls.includes('final'),false)})
