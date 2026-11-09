import assert from 'node:assert/strict'
import test from 'node:test'
import {
  evaluateSmartAdEligibility,
  smartAdCambodiaSlot,
} from '../services/smartAdEligibility.service.js'
import { chooseSmartAdSelection } from '../services/smartAdSelection.service.js'

const now = Date.parse('2026-11-09T13:01:00.000Z')
const baseStory = {
  id: 'story-1', title: 'Test Story', story_type: 'novel', story_status: 'Ongoing',
  status: 'published', deleted_at: null, admin_visibility_status: 'active',
  is_adult: false, is_shadow_exclusive: false,
}
const baseEpisode = {
  first_episode_id: 'episode-1', published_episode_count: 5,
  last_episode_published_at: new Date(now - 10 * 86400000).toISOString(),
}

test('ongoing novels require at least five published episodes', () => {
  assert.equal(evaluateSmartAdEligibility(baseStory, { ...baseEpisode, published_episode_count: 4 }, now).eligible, false)
  assert.equal(evaluateSmartAdEligibility(baseStory, baseEpisode, now).eligible, true)
})

test('ongoing stories expire after 90 days, completed stories do not', () => {
  const stale = { ...baseEpisode, last_episode_published_at: new Date(now - 91 * 86400000).toISOString() }
  assert.equal(evaluateSmartAdEligibility(baseStory, stale, now).eligible, false)
  assert.equal(evaluateSmartAdEligibility({ ...baseStory, story_status: 'Completed' }, stale, now).eligible, true)
})

test('short story must be completed, and all stories need a published first episode', () => {
  const short = { ...baseStory, story_type: 'short_story', story_status: 'Ongoing' }
  assert.equal(evaluateSmartAdEligibility(short, baseEpisode, now).eligible, false)
  assert.equal(evaluateSmartAdEligibility({ ...short, story_status: 'Completed' }, baseEpisode, now).eligible, true)
  assert.equal(evaluateSmartAdEligibility(baseStory, { ...baseEpisode, first_episode_id: null }, now).eligible, false)
})

test('unpublished, hidden and deleted stories are ineligible', () => {
  for (const patch of [{ status: 'draft' }, { admin_visibility_status: 'restricted' }, { deleted_at: new Date(now).toISOString() }]) {
    assert.equal(evaluateSmartAdEligibility({ ...baseStory, ...patch }, baseEpisode, now).eligible, false)
  }
})

test('Cambodia slot boundaries are 00, 06, 12 and 18', () => {
  assert.equal(smartAdCambodiaSlot(now).slot_key, '2026-11-09T18:00')
  assert.equal(smartAdCambodiaSlot(Date.parse('2026-11-09T17:10:00Z')).slot_key, '2026-11-10T00:00')
})

test('selection caps batches at ten, without duplicates or previously seen ads', () => {
  const candidates = Array.from({ length: 40 }, (_, index) => ({
    story_id: `story-${index}`,
    first_episode_id: `episode-${index}`,
    story_kind: index % 12 === 0 ? 'short' : 'novel',
    total_views: index * 12,
    last_episode_published_at: baseEpisode.last_episode_published_at,
    genre: 'fantasy', tags: [],
  }))
  const ads = chooseSmartAdSelection({
    candidates, readerKey: 'reader-1', placement: 'discover',
    slotKey: '2026-11-09T18:00', interests: { fantasy: 4 }, seenInSlot: ['story-0'], now,
  })
  assert.equal(ads.length, 10)
  assert.equal(new Set(ads.map((ad) => ad.story_id)).size, 10)
  assert.equal(ads.some((ad) => ad.story_id === 'story-0'), false)
  assert.equal(ads.filter((ad) => ad.story_kind === 'short').length <= 1, true)
})

test('opening and me select one ad; freeUnlock can loop after exhaustion', () => {
  const candidate = {
    story_id: 'one', first_episode_id: 'first', story_kind: 'novel',
    total_views: 0, last_episode_published_at: baseEpisode.last_episode_published_at,
  }
  assert.equal(chooseSmartAdSelection({ candidates: [candidate], placement: 'opening' }).length, 1)
  assert.equal(chooseSmartAdSelection({ candidates: [candidate], placement: 'me' }).length, 1)
  assert.equal(chooseSmartAdSelection({ candidates: [candidate], placement: 'freeUnlock', seenInSlot: ['one'] }).length, 0)
  assert.equal(chooseSmartAdSelection({ candidates: [candidate], placement: 'freeUnlock', seenInSlot: ['one'], allowFreeUnlockLoop: true }).length, 1)
})
