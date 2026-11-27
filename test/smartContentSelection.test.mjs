import test from 'node:test'
import assert from 'node:assert/strict'
import { createSharedSelection } from '../src/services/smartContent/sharedSelection.service.js'
import { createSharedCaption } from '../src/services/smartContent/sharedCaption.service.js'

const now = Date.parse('2026-11-27T12:00:00Z')
const normalize = value => ({ kh:'km', kr:'ko', jp:'ja' }[value] || value)
const candidate = (id, language, safe = true) => ({ story: { id, story_language: language }, safe })
const create = () => createSharedSelection({ normalizeLanguage: normalize, groupTopics:['night','trending'], isEligible:(c,o)=>c.safe && c.story.story_language===o.language, matchesTopic:()=>true, selectGroup:({candidates,history})=>({stories:candidates.filter(c=>!history.some(h=>h.storyId===c.story.id)),cooldownDays:14}), selectSolo:({candidates,history})=>candidates.filter(c=>!history.some(h=>h.storyId===c.story.id)) })
const choose = createSharedCaption({ normalizeLanguage:normalize, chooseLegacyCaption: o=>({ legacy: o.language }), sharedStoryTags:()=>['romance'] })
const stories = lang => [{ id:'one', story_language:lang }]

test('five languages preserve original candidate objects and reject other languages',()=>{
  for(const language of ['km','en','zh','ja','ko']){
    const a=candidate('a',language), b=candidate('b',language==='en'?'km':'en')
    assert.deepEqual(create().solo({candidates:[a,b],language}),[a])
    assert.equal(a.story.story_language,language)
  }
})
test('unsafe candidates and duplicate ids are removed',()=>{
  const a=candidate('a','zh');assert.deepEqual(create().solo({language:'zh',candidates:[a,a,candidate('b','zh',false)]}),[a])
})
test('history from another language is not projected',()=>{
  const a=candidate('a','ko');assert.deepEqual(create().solo({language:'ko',candidates:[a],history:[{language:'en',storyId:'a'}]}),[a])
})
test('same-language history is passed to legacy selector',()=>{
  assert.deepEqual(create().solo({language:'ko',candidates:[candidate('a','ko')],history:[{language:'kr',storyId:'a'}]}),[])
})
test('group restores original language and legacy metadata',()=>{
  const a=candidate('a','ja');assert.deepEqual(create().group({language:'ja',topic:'night',candidates:[a]}),{stories:[a],cooldownDays:14})
})
test('unknown language or group topic rejects',()=>{
  assert.throws(()=>create().solo({language:'fr',candidates:[]}));assert.throws(()=>create().group({language:'en',candidates:[],topic:'solo'}))
})
test('Khmer and English captions delegate to original library',()=>{
  for(const language of ['km','en']) assert.deepEqual(choose({language,topic:'night',stories:stories(language),now}),{legacy:language})
})
test('three added languages generate localized captions',()=>{
  for(const [language,pattern] of [['zh',/阅读/],['ja',/作品/],['ko',/작품/]]){const r=choose({language,topic:'night',stories:stories(language),now});assert.match(r.heading,pattern);assert.ok(r.tagLine);assert.ok(r.captionId.startsWith(language+':'))}
})
test('caption rotation respects recent and pending history',()=>{
  const history=[];for(let i=0;i<4;i++){const r=choose({language:'zh',topic:'new',stories:stories('zh'),history,now});assert.ok(r);history.push({language:'zh',captionId:r.captionId,status:'ready'})}assert.equal(choose({language:'zh',topic:'new',stories:stories('zh'),history,now}),null)
})
test('caption rejects mismatched story language',()=>assert.throws(()=>choose({language:'ko',topic:'new',stories:stories('en'),now})))
