import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectShadowPreOrderAddress as address } from '../services/shadowAi/shadowAiPreOrderAddress.js'
import { normalizeShadowPreOrderRules as normalize, previewShadowPreOrderRequirements as preview, evaluateShadowPreOrderRules as evaluate } from '../services/shadowAi/shadowAiPreOrderRequirements.js'
import { createShadowAiPreOrderContext } from '../services/shadowAi/shadowAiPreOrderContext.service.js'

const author = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const campaign = '33333333-3333-4333-8333-333333333333'
const book = '44444444-4444-4444-8444-444444444444'
const now = Date.parse('2026-11-27T08:00:00Z')
const record = { id: campaign, author_page_id: author, status: 'active', published_at: '2026-11-25T00:00:00Z', open_at: '2026-11-26T00:00:00Z', close_at: '2026-11-29T00:00:00Z', stock_snapshot_complete: true, books: [{ id: book, title: 'Book', editions: { standard: { enabled: true, price_usd: 5, available: 2, stock_verified: true }, limited: { enabled: false, price_usd: 0, available: 0, stock_verified: true } } }], delivery_companies: [{ company_key: 'jnt', company_name: 'J&T', fee_usd: 1 }] }
const make = (row = record, list = [row]) => createShadowAiPreOrderContext({ listCampaigns: async () => list, getCampaign: async () => row, now: () => now })

test('province or capital alone is sufficient', () => { for (const x of ['ភ្នំពេញ','PP','ខេត្តកណ្តាល','សៀមរាប','Kep','ក្រុងតាខ្មៅ']) assert.equal(address(x).ok, true, x) })
test('address preserves user text and extracts province', () => { assert.deepEqual(address('ទួលគោក ភ្នំពេញ'), { ok: true, delivery_address: 'ទួលគោក ភ្នំពេញ', province_city: 'ភ្នំពេញ', province_city_en: 'Phnom Penh' }) })
test('unknown and ambiguous address not guessed', () => { assert.equal(address('នៅផ្ទះ').code,'PROVINCE_OR_CITY_REQUIRED'); assert.equal(address('ភ្នំពេញ ឬ កណ្ដាល').code,'PROVINCE_OR_CITY_AMBIGUOUS'); assert.equal(address('apple').ok,false) })
test('template path never calls AI', async () => { const data = await preview({ templateRules: [{field:'second_phone',condition:'always'}], runAi: () => { throw Error('unexpected call') } }); assert.equal(data.rules.length,1); assert.equal(data.confirmed,false) })
test('custom rules are preview only and review preserved', async () => { const data = await preview({ actorUserId: author, instruction:'Limited ត្រូវមាន Telegram', runAi: async req => { assert.equal(req.task,'author_requirements'); return { data:{ rules:[{field:'telegram_username',condition:'limited'}], needs_review:['Unclear note'] } } } }); assert.equal(data.rules[0].condition,'limited'); assert.equal(data.confirmed,false); assert.equal(data.needs_review.length,1) })
test('reject unsupported and inconsistent requirements', () => { assert.throws(() => normalize([{field:'otp',condition:'always'}])); assert.throws(() => normalize([{field:'english_signature_name',condition:'limited'}])) })
test('rule conditions do not invent selections', () => { const rules = [{field:'second_phone',condition:'outside_phnom_penh'},{field:'telegram_username',condition:'limited'}]; assert.deepEqual(evaluate(rules), { required:[],pending:['second_phone','telegram_username'] }); assert.deepEqual(evaluate(rules,{province_city:'ភ្នំពេញ',items:[{edition:'limited'}]}), {required:['telegram_username'],pending:[]}) })
test('campaign listing scoped and stock not asserted', async () => { const context = make(record,[record,{...record,author_page_id:other},{...record,status:'closed'}]); const result=await context.list(author); assert.equal(result.campaigns.length,1); assert.equal(result.stock_verified,false) })
test('selected campaign verified and delivery mapped', async () => { const result=await make().detail(author,campaign); assert.equal(result.can_book,true); assert.equal(result.books[0].editions[0].available,2); assert.equal(result.delivery_companies[0].company_key,'jnt') })
test('reject cross-author, closed and unverified detail', async () => { await assert.rejects(make().detail(other,campaign),{code:'SHADOW_AI_CAMPAIGN_UNAVAILABLE'}); await assert.rejects(make({...record,close_at:'2026-11-27T07:00:00Z'}).detail(author,campaign),{code:'SHADOW_AI_CAMPAIGN_UNAVAILABLE'}); await assert.rejects(make({...record,stock_snapshot_complete:false}).detail(author,campaign),{code:'SHADOW_AI_CONTEXT_UNAVAILABLE'}) })
test('sold out detail cannot book', async () => { const row=structuredClone(record); row.books[0].editions.standard.available=0; assert.equal((await make(row).detail(author,campaign)).can_book,false) })
