const test = require('node:test');
const assert = require('node:assert/strict');
const { createStateStore } = require('../src/services/taskCenter/smartAuto/stateStore.cjs');
const { createSmartAutoService } = require('../src/services/taskCenter/smartAuto/service.cjs');
const start = Date.parse('2026-11-24T00:00:00+07:00');
const hour = 3600000;

function fixture({ mode = 'smart_auto', conflict = false } = {}) {
  let row = null, now = start, writes = 0, attempts = 0;
  const supabase = {
    from(name) {
      assert.equal(name, 'task_center_smart_auto_state');
      return { select: () => ({ eq: (column, id) => ({ maybeSingle: async () => { assert.equal(column, 'reader_id'); assert.equal(id, 'r'); return { data: structuredClone(row) }; } }) }) };
    },
    async rpc(name, args) {
      assert.equal(name, 'task_center_smart_auto_save_v1');
      attempts++;
      if (conflict || args.p_expected_revision !== (row?.revision ?? 0)) return { data: false };
      row = { revision: args.p_expected_revision + 1, day_start_ms: args.p_day_start_ms, missions: structuredClone(args.p_missions), daily_assigned_ids: structuredClone(args.p_daily_assigned_ids) };
      writes++;
      return { data: true };
    }
  };
  const loadContext = async () => ({ mode, group: 'khmer', language: 'km', templates: [{ slotId: '1', rewardCoins: 10, targetMinutes: 2 }, { slotId: '2', rewardCoins: 20, targetMinutes: 5 }], completedIds: [], readIds: [], exposureHistory: [], unavailableIds: [] });
  const getCandidates = async () => Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, eligible: true, language: 'km', views: i }));
  const make = () => createSmartAutoService({ withReaderTransaction: createStateStore({ supabase, loadContext }), getCandidates, clock: () => now });
  return { make, counts: () => ({ writes, attempts }), row: () => structuredClone(row), advance: hours => { now += hours * hour; } };
}

test('independent workers resolve concurrent assignments with one committed selection', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.make()({ readerId: 'r' }), f.make()({ readerId: 'r' })]);
  assert.deepEqual(a, b);
  assert.equal(f.counts().writes, 1);
  assert.equal(f.counts().attempts, 2);
});

test('daily assignment cap resets on Cambodia midnight', async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) {
    await f.make()({ readerId: 'r' });
    f.advance(6);
  }
  assert.equal(f.row().daily_assigned_ids.length, 8);
  const next = await f.make()({ readerId: 'r' });
  assert.equal(next.missions.length, 2);
  assert.equal(f.row().daily_assigned_ids.length, 2);
  assert.equal(f.row().day_start_ms, start + 24 * hour);
});

test('manual and legacy auto do not save state', async () => {
  for (const mode of ['manual', 'auto']) {
    const f = fixture({ mode });
    assert.deepEqual(await f.make()({ readerId: 'r' }), { mode, handled: false });
    assert.equal(f.counts().attempts, 0);
  }
});

test('persistent conflicts stop after four attempts without returning an uncommitted selection', async () => {
  const f = fixture({ conflict: true });
  await assert.rejects(f.make()({ readerId: 'r' }), { code: 'SMART_AUTO_CONFLICT' });
  assert.deepEqual(f.counts(), { writes: 0, attempts: 4 });
});
