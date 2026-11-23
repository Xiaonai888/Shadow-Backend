import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSmartPromotionRequest, SmartPromotionInputError } from '../services/smartPromotionRequest.service.js'

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function invalid(body) {
  assert.throws(() => parseSmartPromotionRequest(body), SmartPromotionInputError)
}

test('valid promotion request normalizes language, interest and story IDs', () => {
  const value = parseSmartPromotionRequest({
    story_language: 'Khmer',
    interests: { Romance: 12, Fantasy: 3 },
    exclude_story_ids: [id(1).toUpperCase(), id(1)],
  })
  assert.equal(value.language, 'km')
  assert.equal(value.interests.romance, 12)
  assert.equal(value.interests.fantasy, 3)
  assert.deepEqual(value.excludeStoryIds, [id(1)])
})

test('all five supported Story Languages are accepted', () => {
  for (const language of ['km', 'en', 'zh', 'ja', 'ko']) {
    assert.equal(parseSmartPromotionRequest({ story_language: language }).language, language)
  }
})

test('rejects malformed request, languages and invalid interests', () => {
  invalid(null)
  invalid([])
  invalid({ story_language: 'xx' })
  invalid({ story_language: 'km', interests: [] })
  invalid({ story_language: 'km', interests: { romance: 41 } })
  invalid({ story_language: 'km', interests: { romance: -1 } })
  invalid({ story_language: 'km', interests: { romance: Infinity } })
  invalid({ story_language: 'km', interests: { ['x'.repeat(61)]: 1 } })
})

test('rejects oversized interest lists and exclusions', () => {
  invalid({ story_language: 'km', interests: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`g${i}`, 1])) })
  invalid({ story_language: 'km', exclude_story_ids: Array.from({ length: 151 }, (_, i) => id(i + 1)) })
  invalid({ story_language: 'km', exclude_story_ids: ['not-a-uuid'] })
})
