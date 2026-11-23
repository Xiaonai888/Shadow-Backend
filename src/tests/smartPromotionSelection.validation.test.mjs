import test from 'node:test'
import assert from 'node:assert/strict'
import { selectSmartPromotionOffers } from '../services/smartPromotionSelection.service.js'

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const candidates = Array.from({ length: 12 }, (_, index) => ({
  story_id: id(index + 1),
  story_title: `Story ${index + 1}`,
  story_language: 'km',
  first_episode_id: id(index + 101),
  cover_url: `/cover-${index + 1}.jpg`,
  main_genre: index < 6 ? 'romance' : 'action',
  genre: index < 6 ? 'romance' : 'action',
  tags: [],
  story_kind: 'novel',
  total_views: index + 10,
  total_episodes: 15,
  locked_episode_count: 10,
  promotion_eligible: true,
  created_at: '2024-01-01T00:00:00Z',
  last_episode_published_at: '2026-11-01T00:00:00Z',
}))

function choose(extra = {}) {
  return selectSmartPromotionOffers({
    candidates,
    language: 'km',
    readerKey: 'reader-a',
    slotKey: '2026-11-23T06:00',
    interests: { romance: 40 },
    now: Date.parse('2026-11-23T07:00:00Z'),
    ...extra,
  })
}

test('promotion selects at most three eligible, distinct stories', () => {
  const offers = choose()
  assert.equal(offers.length, 3)
  assert.equal(new Set(offers.map((offer) => offer.story_id)).size, 3)
  assert.ok(offers.every((offer) => offer.promotion_eligible && offer.discount_percent === 50))
})

test('different interests can change the preferred story', () => {
  const romance = choose({ interests: { romance: 40 }, readerKey: 'same-reader' })
  const action = choose({ interests: { action: 40 }, readerKey: 'same-reader' })
  assert.equal(romance[0].main_genre, 'romance')
  assert.equal(action[0].main_genre, 'action')
})

test('fully purchased stories are replaced without altering the eligible catalog', () => {
  const owned = new Map([[candidates[0].story_id, 10]])
  const offers = choose({ ownedCounts: owned, excludeStoryIds: candidates.slice(1, 3).map((story) => story.story_id) })
  assert.equal(offers.length, 3)
  assert.ok(offers.every((offer) => offer.story_id !== candidates[0].story_id))
  assert.equal(candidates[0].locked_episode_count, 10)
})

test('partially owned episodes produce a price based on remaining locks', () => {
  const story = candidates[0]
  const offers = choose({ candidates: [story], ownedCounts: new Map([[story.story_id, 7]]) })
  assert.equal(offers.length, 1)
  assert.equal(offers[0].locked_episode_count, 3)
  assert.equal(offers[0].original_price_diamonds, 30)
  assert.equal(offers[0].discounted_price_diamonds, 15)
})

test('the same slot retains valid previously selected stories', () => {
  const previous = [candidates[7].story_id, candidates[5].story_id]
  const offers = choose({ selectedThisSlotIds: previous })
  assert.deepEqual(offers.slice(0, 2).map((offer) => offer.story_id), previous)
})

test('ineligible stories are never promoted', () => {
  const offers = choose({ candidates: [
    { ...candidates[0], locked_episode_count: 4 },
    { ...candidates[1], promotion_eligible: false },
    { ...candidates[2], story_language: 'en' },
  ] })
  assert.equal(offers.length, 0)
})
