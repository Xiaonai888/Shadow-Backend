const test = require('node:test');
const assert = require('node:assert/strict');
const { createCandidateSource } = require('../src/services/taskCenter/smartAuto/candidateSource.cjs');
const { createSmartAutoService } = require('../src/services/taskCenter/smartAuto/service.cjs');
const start = Date.parse('2026-11-24T00:00:00+07:00');
const hour = 3600000;
const pool = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, language: 'km', eligible: true, views: i }));

function fixture(overrides = {}) {
  let now = start, reads = 0, writes = 0, poolReads = 0, tail = Promise.resolve();
  let state = { mode: 'smart_auto', group: 'khmer', language: 'km', templates: [{ slotId: '1', rewardCoins: 20, targetMinutes: 2 }, { slotId: '2', rewardCoins: 30, targetMinutes: 5 }], previous: [], dailyAssignedIds: [], completedIds: [], readIds: [], exposureHistory: [], unavailableIds: [], ...overrides };
  const getCandidates = createCandidateSource({ readPool: async () => { poolReads++; return pool; } });
  const withReaderTransaction = (readerId, work) => {
    const run = tail.then(() => work({ load: async () => { reads++; return structuredClone(state); }, save: async data => { writes++; state = { ...state, previous: data.missions, dailyAssignedIds: data.dailyAssignedIds }; } }));
    tail = run.catch(() => {});
    return run;
  };
  const resolve = createSmartAutoService({ withReaderTransaction, getCandidates, clock: () => now });
  return { resolve: () => resolve({ readerId: 'reader' }), advance: h => { now += h * hour; }, change: data => { state = { ...state, ...data }; }, counts: () => ({ reads, writes, poolReads }) };
}

test('old modes do not select or write Smart Auto state', async () => {
  for (const mode of ['manual', 'auto']) {
    const f = fixture({ mode });
    assert.deepEqual(await f.resolve(), { mode, handled: false });
    assert.deepEqual(f.counts(), { reads: 1, writes: 0, poolReads: 0 });
  }
});

test('same-window refresh and concurrent requests do not reroll or write twice', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.resolve(), f.resolve()]);
  assert.equal(a.missions.length, 2);
  assert.deepEqual(a, b);
  assert.deepEqual(f.counts(), { reads: 2, writes: 1, poolReads: 1 });
});

test('claimed mission does not refill until next window', async () => {
  const f = fixture();
  const a = await f.resolve();
  f.change({ previous: a.missions.map(m => ({ ...m, status: 'claimed' })) });
  f.advance(4);
  const b = await f.resolve();
  assert.deepEqual(b.missions.map(m => m.status), ['claimed', 'claimed']);
  assert.equal(f.counts().poolReads, 1);
  f.advance(2);
  const c = await f.resolve();
  assert.equal(c.missions.length, 2);
  assert.ok(c.missions.every(m => !a.missions.some(p => p.storyId === m.storyId)));
});

test('active missions retain their rewards and targets after rotation', async () => {
  const f = fixture();
  const a = await f.resolve();
  const previous = a.missions.map((m, i) => ({ ...m, status: i ? 'claimable' : 'in_progress', expiresAt: start + 7 * hour }));
  f.change({ previous, templates: [{ slotId: '1', rewardCoins: 999, targetMinutes: 10 }, { slotId: '2', rewardCoins: 999, targetMinutes: 10 }] });
  f.advance(6);
  assert.deepEqual((await f.resolve()).missions, previous);
  assert.equal(f.counts().poolReads, 1);
});

test('candidate source is read-only, scoped, deduplicated and bounded', async () => {
  const data = [{ id: 'a', language: 'en', eligible: true, views: 1 }, { id: 'a', language: 'en', eligible: true }, { id: 'b', language: 'km', eligible: true }, { id: 'c', language: 'en', eligible: false }];
  const copy = structuredClone(data);
  const source = createCandidateSource({ readPool: async args => { assert.deepEqual(args, { group: 'international', language: 'en', limit: 1000 }); return data; } });
  assert.deepEqual(await source({ group: 'international', language: 'en' }), [data[0]]);
  assert.deepEqual(data, copy);
});

test('candidate errors propagate without saving a partial selection', async () => {
  let saved = false;
  const f = createSmartAutoService({ clock: () => start, getCandidates: async () => { throw new Error('pool offline'); }, withReaderTransaction: async (id, work) => work({ load: async () => ({ mode: 'smart_auto', group: 'khmer', language: 'km', templates: [{ slotId: '1', rewardCoins: 10, targetMinutes: 2 }], previous: [], dailyAssignedIds: [], completedIds: [], readIds: [], exposureHistory: [], unavailableIds: [] }), save: async () => { saved = true; } }) });
  await assert.rejects(f({ readerId: 'reader' }), /pool offline/);
  assert.equal(saved, false);
});
