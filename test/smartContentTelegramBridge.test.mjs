import test from 'node:test'
import assert from 'node:assert/strict'
import { sharedSelection, chooseSharedCaption } from '../src/services/smartContent/telegramContentBridge.service.js'
import { selectRecommendationGroup } from '../src/services/telegramPromotion/recommendationV2.service.js'
import { selectSoloV2 } from '../src/services/telegramPromotion/optionalV2.service.js'
import { chooseGroupCaption } from '../src/services/telegramPromotion/captionLibraryV2.service.js'

const now=Date.parse('2026-11-27T12:00:00Z')
const published=new Date(now-3*86400000).toISOString()
const make=(language)=>Array.from({length:5},(_,i)=>({story:{id:`s${i}`,title:`Story ${i}`,author_id:`a${i}`,cover_url:'https://example.com/cover.png',story_language:language,story_status:'completed',status:'published',story_type:'novel',total_views:i,main_genre:'romance',tags:['romance']},episode:{id:`ep${i}`,story_id:`s${i}`,status:'published',first_published_at:published,published_at:published},publishedEpisodeCount:5,activity7:i+1,authorLastActiveAt:published,lastEpisodePublishedAt:published}))
for(const language of ['km','en']){
  test(`${language} legacy group and solo parity`,()=>{
    const candidates=make(language), options={language,candidates,history:[{language,storyId:'s0',status:'sent',sentAt:published}],now,topic:'romance',count:3,seed:'parity'}
    assert.deepEqual(sharedSelection.group(options),selectRecommendationGroup(options))
    assert.deepEqual(sharedSelection.solo(options),selectSoloV2(options))
    const captionOptions={language,topic:'romance',stories:candidates.map(c=>c.story),now,seed:'parity'}
    assert.deepEqual(chooseSharedCaption(captionOptions),chooseGroupCaption(captionOptions))
  })
}
for(const language of ['zh','ja','ko']){
  test(`${language} uses actual V2 algorithm without language leakage`,()=>{
    const candidates=make(language), wrong=make('en')[0], history=[{language,storyId:'s0',status:'sending'}]
    const result=sharedSelection.group({language,candidates:[wrong,...candidates],history,topic:'romance',count:3,now,seed:'parity'})
    assert.equal(result.stories.length,3)
    assert.ok(result.stories.every(c=>c.story.story_language===language&&c.story.id!=='s0'))
    assert.ok(chooseSharedCaption({language,topic:'romance',stories:result.stories.map(c=>c.story),now}))
  })
}
