import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeShadowLocalKnowledge, createShadowLocalKnowledgeDictionary } from '../services/shadowAi/local/shadowLocalKnowledge.js'
import { interpretShadowLocalFollowup } from '../services/shadowAi/local/shadowLocalFollowup.js'
const source=readFileSync(new URL('../../sql/20261127_shadow_ai_local_book_seed_v1.sql',import.meta.url),'utf8')
const aliases=JSON.parse(source.split('$aliases$')[1])
const dictionary=createShadowLocalKnowledgeDictionary({version:2,aliases})
const id='11111111-1111-4111-8111-111111111111'
const catalog={books:[{id,title:'Moon',editions:['standard','limited']}],delivery_companies:[{key:'jnt',name:'J&T'}],signature_enabled:true}
const parse=(message,current_draft={items:[]})=>interpretShadowLocalFollowup({message,current_draft,catalog},dictionary)
test('starter snapshot validates without collisions or duplicates',()=>{assert.deepEqual(normalizeShadowLocalKnowledge(aliases),aliases);assert.ok(aliases.length<=250)})
for(const row of aliases.filter(x=>x.group==='questions'))test(`book question: ${row.alias}`,()=>{const result=parse(row.alias+'?');assert.equal(result.intent,'question');assert.equal(result.question,row.canonical);assert.equal(result.items,null);assert.equal(result.name,null)})
test('new field and edition labels build a draft',()=>{const result=parse('សៀវភៅ: Moon\nប្រភេទសៀវភៅ: normal edition\nចំនួនសៀវភៅ: ២ក្បាល\nឈ្មោះអ្នកកក់: Dara');assert.equal(result.intent,'booking');assert.deepEqual(result.items,[{book_id:id,edition:'standard',quantity:2}]);assert.equal(result.name,'Dara')})
test('unknown question and unsupported payment message never book',()=>{for(const text of ['ផ្ទេរលុយរួចហើយ','OTP: 123456','book: Unknown']){const result=parse(text);assert.equal(result.intent,'unclear');assert.equal(result.items,null)}})
