import assert from 'node:assert/strict'
import test from 'node:test'
import { selectDiverseSmartAdCandidates } from '../services/smartAdDiversityPolicy.service.js'

const NOW = Date.parse('2026-11-16T00:00:00Z')

function stories(total = 100) {
  return Array.from({ length: total }, (_, i) => ({
    story_id: `story-${i}`,
    first_episode_id: `episode-${i}`,
    story_kind: i % 15 === 0 ? 'short' : 'novel',
    total_views: i * 4,
    created_at: new Date(NOW - (i % 5 === 0 ? 2 : 120) * 86400000).toISOString(),
    genre: i % 2 === 0 ? 'fantasy' : 'romance',
  }))
}

function select(patch = {}) {
  return selectDiverseSmartAdCandidates({
    candidates: stories(),
    seed: 'reader:slot:batch',
    preferredScore: (story) => 1000 - Number(story.story_id.split('-')[1]),
    now: NOW,
    ...patch,
  })
}

test('creates a unique, bounded ten-ad batch', () => {
  const selected = select()
  assert.equal(selected.length, 10)
  assert.equal(new Set(selected.map((ad) => ad.story_id)).size, 10)
})

test('chooses seven-day unseen stories ahead of previously seen stories', () => {
  const recent = new Map(stories(30).map((story) => [story.story_id, NOW - 86400000]))
  const selected = select({ recentHistory: recent })
  assert.equal(selected.length, 10)
  assert.equal(selected.some((story) => recent.has(story.story_id)), false)
})

test('hard exclusions are never replayed', () => {
  const hardExcludedIds = stories(96).map((story) => story.story_id)
  const selected = select({ hardExcludedIds })
  assert.deepEqual(selected.map((story) => story.story_id).sort(), ['story-96', 'story-97', 'story-98', 'story-99'])
})

test('reuses the least recently seen candidates only after unseen options are exhausted', () => {
  const source = stories(3)
  const recentHistory = new Map([
    ['story-0', NOW - 3600000],
    ['story-1', NOW - 86400000],
  ])
  const selected = selectDiverseSmartAdCandidates({
    candidates: source,
    recentHistory,
    allowRecentFallback: true,
    now: NOW,
    seed: 'test',
  })
  assert.deepEqual(selected.map((story) => story.story_id), ['story-2', 'story-1', 'story-0'])
})

test('one-ad placements still receive exactly one eligible story', () => {
  assert.equal(select({ limit: 1 }).length, 1)
})

test('new-story candidates are given dedicated slots when available', () => {
  const selected = select()
  const recentlyCreated = selected.filter((story) => NOW - Date.parse(story.created_at) < 30 * 86400000)
  assert.ok(recentlyCreated.length >= 2)
})

test('holds back recently seen stories while the wider catalog may contain unseen stories', () => {
  const source = stories(10)
  const recentHistory = new Set(source.map((story) => story.story_id))
  const selected = selectDiverseSmartAdCandidates({ candidates: source, recentHistory, now: NOW })
  assert.equal(selected.length, 0)
})
