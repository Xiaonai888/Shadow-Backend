const test = require('node:test');
const assert = require('node:assert/strict');
const { getWindow } = require('../src/services/taskCenter/smartAuto/policy.cjs');
const { planMissions } = require('../src/services/taskCenter/smartAuto/plan.cjs');
const { selectStories } = require('../src/services/taskCenter/smartAuto/select.cjs');
const now = Date.parse('2026-11-24T00:00:00+07:00');
const hour = 3600000;
const candidates = Array.from({ length: 20 }, (_, i) => ({ id: `story-${i}`, language: 'km', eligible: true, views: i * 10 }));
const templates = [{ slotId: '1', rewardCoins: 200, targetMinutes: 2 }, { slotId: '2', rewardCoins: 200, targetMinutes: 5 }];
const input = { readerId: 'reader-a', language: 'km', now, templates, candidates, previous: [], dailyAssignedIds: [], completedIds: [], readIds: [], exposureHistory: [], unavailableIds: [] };

test('Cambodia rotation uses four fixed daily windows', () => {
  assert.equal(getWindow(now + 5 * hour).start, now);
  assert.equal(getWindow(now + 6 * hour).start, now + 6 * hour);
  assert.equal(getWindow(now + 24 * hour).dayStart, now + 24 * hour);
});

test('same window is stable and completed slot does not refill', () => {
  const first = planMissions(input);
  assert.equal(first.created.length, 2);
  const previous = first.missions.map((m, i) => i === 0 ? { ...m, status: 'claimed' } : m);
  const again = planMissions({ ...input, now: now + hour, previous, dailyAssignedIds: first.dailyAssignedIds });
  assert.deepEqual(again.missions, previous);
  assert.equal(again.created.length, 0);
});

test('four windows assign at most eight distinct stories', () => {
  let previous = [], dailyAssignedIds = [];
  for (let i = 0; i < 4; i++) {
    const result = planMissions({ ...input, now: now + i * 6 * hour, previous, dailyAssignedIds });
    assert.equal(result.created.length, 2);
    previous = result.missions;
    dailyAssignedIds = result.dailyAssignedIds;
  }
  assert.equal(new Set(dailyAssignedIds).size, 8);
  const blocked = planMissions({ ...input, now: now + 19 * hour, previous, dailyAssignedIds, unavailableIds: previous.map(m => m.storyId) });
  assert.equal(blocked.created.length, 0);
});

test('rotation preserves active and claimable snapshots', () => {
  const first = planMissions(input);
  const previous = first.missions.map((m, i) => ({ ...m, status: i ? 'claimable' : 'in_progress' }));
  const result = planMissions({ ...input, now: now + 6 * hour, previous, dailyAssignedIds: first.dailyAssignedIds, templates: templates.map(t => ({ ...t, rewardCoins: 999 })) });
  assert.deepEqual(result.missions, previous);
  assert.equal(result.created.length, 0);
});

test('filter language, eligibility, completed and recent exposure', () => {
  const stories = [{ id: 'fresh', eligible: true, language: 'km', views: 50 }, { id: 'recent', eligible: true, language: 'km', views: 0 }, { id: 'done', eligible: true, language: 'km' }, { id: 'foreign', eligible: true, language: 'en' }, { id: 'hidden', eligible: false, language: 'km' }];
  const args = { readerId: 'reader-a', language: 'km', now, windowStart: now, candidates: stories, completedIds: ['done'], readIds: [], exposureHistory: [{ storyId: 'recent', seenAt: now - hour }], excludeIds: [], limit: 1 };
  assert.deepEqual(selectStories(args), ['fresh']);
  assert.deepEqual(selectStories({ ...args, limit: 2 }), ['fresh', 'recent']);
});

test('unavailable active mission is invalidated but earned claim remains', () => {
  const first = planMissions(input);
  const previous = first.missions.map((m, i) => ({ ...m, status: i ? 'claimable' : 'in_progress' }));
  const result = planMissions({ ...input, previous, dailyAssignedIds: first.dailyAssignedIds, unavailableIds: previous.map(m => m.storyId) });
  assert.equal(result.invalidated.length, 1);
  assert.equal(result.created.length, 1);
  assert.deepEqual(result.missions.find(m => m.slotId === '2'), previous[1]);
});

test('new day has its own assignment cap and foreign language is supported', () => {
  const result = planMissions({ ...input, now: now + 24 * hour, language: 'en', candidates: [{ id: 'english', language: 'en', eligible: true }] });
  assert.deepEqual(result.created.map(m => m.storyId), ['english']);
});
