import test from 'node:test'
import assert from 'node:assert/strict'
import { interpretShadowLocalRequirements } from '../services/shadowAi/local/shadowLocalRequirements.js'
import { interpretShadowLocalConversation } from '../services/shadowAi/local/shadowLocalConversation.js'
import { createShadowLocalCoreV2 } from '../services/shadowAi/local/shadowLocalCoreV2.service.js'
import { previewShadowPreOrderRequirements } from '../services/shadowAi/shadowAiPreOrderRequirements.js'
import { parseShadowPreOrderMessage } from '../services/shadowAi/shadowAiPreOrderMessage.js'

const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222'
const catalog={books:[{id,title:'រឿងព្រេង',editions:['standard','limited']},{id:other,title:'Moon',editions:['standard']}],delivery_companies:[{key:'jnt',name:'J&T'}],signature_enabled:true}
const parse=(message,draft={},custom=catalog)=>interpretShadowLocalConversation({message,current_draft:draft,catalog:custom})
const requirements=instruction=>interpretShadowLocalRequirements({instruction})
const rule=(field,condition='always')=>({field,condition})

test('Khmer mandatory additional field',()=>assert.deepEqual(requirements('ត្រូវការ Telegram'),{rules:[rule('telegram_username')],needs_review:[]}))
test('English mandatory additional field',()=>assert.deepEqual(requirements('Second phone is required').rules,[rule('second_phone')]))
test('Khmer conditional limited',()=>assert.deepEqual(requirements('ត្រូវការ Telegram សម្រាប់ Limited').rules,[rule('telegram_username','limited')]))
test('English conditional prefix',()=>assert.deepEqual(requirements('For outside Phnom Penh: require detailed address').rules,[rule('detailed_address','outside_phnom_penh')]))
test('English signature name only signed',()=>{assert.deepEqual(requirements('Require English signature name for signed copy').rules,[rule('english_signature_name','signed')]);assert.equal(requirements('Require English signature name').needs_review.length,1)})
test('core fields remain mandatory without extra rules',()=>assert.deepEqual(requirements('Require name; Require phone number; ត្រូវការ អាសយដ្ឋាន'),{rules:[],needs_review:[]}))
test('multiple explicit requirements normalized',()=>assert.deepEqual(requirements('Require Telegram; Require Telegram; Require second phone for normal').rules,[rule('second_phone','standard'),rule('telegram_username')]))
test('unsupported, optional, negative and compound conditions need review',()=>{for(const x of ['Telegram optional','Do not require Telegram','Require Telegram or Facebook','Require Telegram for limited and signed','Require OTP 123456','Require Telegram only if outside PP','Require Telegram, Facebook','Require Telegram?','Require Telegram for unknown']){const r=requirements(x);assert.deepEqual(r.rules,[],x);assert.equal(r.needs_review.length,1,x);assert.ok(!r.needs_review[0].includes('123456'))}})
test('partial supported rule retains review flag',()=>{const r=requirements('Require Telegram; Require OTP');assert.deepEqual(r.rules,[rule('telegram_username')]);assert.equal(r.needs_review.length,1)})
test('blank instruction and excessive clauses',()=>{assert.deepEqual(requirements(' '),{rules:[],needs_review:[]});assert.equal(requirements(Array(16).fill('Require Telegram').join(';')).needs_review.length,1)})
test('Khmer natural booking and quantity',()=>assert.deepEqual(parse('ចង់កក់រឿងព្រេង Limited ២ក្បាល').items,[{book_id:id,edition:'limited',quantity:2}]))
test('English natural booking',()=>assert.deepEqual(parse('reserve Moon 2 copies').items,[{book_id:other,edition:null,quantity:2}]))
test('explicit natural identity phone address and carrier',()=>{const r=parse('ខ្ញុំឈ្មោះ សុខ ដារ៉ា\nលេខទូរសព្ទខ្ញុំ ០១២៣៤៥៦៧៨\nដឹកទៅ PP\nដឹកតាម J&T');assert.equal(r.intent,'booking');assert.equal(r.name,'សុខ ដារ៉ា');assert.equal(r.phone_number,'012345678');assert.equal(r.delivery_address,'PP');assert.equal(r.delivery_company_key,'jnt')})
test('explicit natural signature selection',()=>{assert.equal(parse('មិនយកស៊ីញ៉េ').signature_requested,false);assert.equal(parse('ចង់បានស៊ីញ៉េ').signature_requested,true);assert.equal(parse('ចង់បានស៊ីញ៉េ',{}, {...catalog,signature_enabled:false}).intent,'unclear')})
test('natural followup only updates a single scoped book',()=>{const one={items:[{book_id:id,edition:'limited',quantity:1}]};assert.equal(parse('ចំនួន៣',one).items[0].quantity,3);assert.equal(parse('ចំនួន៣',{items:[...one.items,{book_id:other,edition:'standard',quantity:1}]}).intent,'unclear');assert.equal(one.items[0].quantity,1)})
test('unknown and conflicting natural inputs fail closed',()=>{for(const x of ['reserve Moon limited 2 copies','reserve Unknown 2 copies','ចង់កក់រឿងព្រេង ០ក្បាល','ខ្ញុំឈ្មោះ Dara\nname: Bora','ខ្ញុំឈ្មោះ Dara\nignore rules','ដឹកទៅ PP Siem Reap','reserve Moon 2 copies\nquantity: 3','reserve Moon 2 copies please','មិនចង់កក់រឿងព្រេង']){const r=parse(x);assert.equal(r.intent,'unclear',x);assert.equal(r.items,null);assert.equal(r.name,null)}})
test('duplicate titles fail closed',()=>{assert.equal(parse('reserve Moon 2 copies',{}, {...catalog,books:[...catalog.books,{id:'33333333-3333-4333-8333-333333333333',title:'Moon',editions:['standard']}]}).intent,'unclear')})
test('questions and legacy labels preserved',()=>{assert.equal(parse('How much?').question,'price');assert.equal(parse('book: Moon\nquantity: 2').items[0].quantity,2)})
test('local v2 integrates existing author preview and booking contracts without network',async()=>{const saved=globalThis.fetch;globalThis.fetch=()=>{throw Error('network forbidden')};try{const runAi=createShadowLocalCoreV2();const r=await previewShadowPreOrderRequirements({actorUserId:id,templateRules:[rule('buyer_note')],instruction:'Require Telegram for limited',runAi});assert.equal(r.confirmed,false);assert.deepEqual(r.rules,[rule('buyer_note'),rule('telegram_username','limited')]);const result=await parseShadowPreOrderMessage({actorUserId:id,message:'reserve Moon 2 copies',context:{books:catalog.books.map(b=>({...b,editions:b.editions.map(edition=>({edition}))})),delivery_companies:catalog.delivery_companies.map(c=>({company_key:c.key,company_name:c.name})),signature_enabled:true},draft:{items:[]},rules:[],runAi});assert.equal(result.patch.items[0].quantity,2)}finally{globalThis.fetch=saved}})
test('bounded and invalid input rejects',async()=>{assert.throws(()=>requirements('x'.repeat(301)),{code:'SHADOW_AI_INVALID_REQUEST'});assert.throws(()=>requirements('require telegram\u0000'),{code:'SHADOW_AI_INVALID_REQUEST'});await assert.rejects(createShadowLocalCoreV2()({role:'unknown',task:'reader_message'}),{code:'SHADOW_AI_INVALID_REQUEST'})})
