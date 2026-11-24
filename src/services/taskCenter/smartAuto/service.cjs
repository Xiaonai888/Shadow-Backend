const { isDeepStrictEqual } = require('node:util');
const { planMissions } = require('./plan.cjs');
const { getWindow } = require('./policy.cjs');

function createSmartAutoService({ withReaderTransaction, getCandidates, clock = Date.now }) {
  if (typeof withReaderTransaction !== 'function' || typeof getCandidates !== 'function' || typeof clock !== 'function') throw new TypeError('Invalid Smart Auto dependencies');
  return async function resolveMissions({ readerId }) {
    if (typeof readerId !== 'string' || !readerId.trim()) throw new TypeError('Invalid reader ID');
    return withReaderTransaction(readerId, async tx => {
      if (!tx || typeof tx.load !== 'function' || typeof tx.save !== 'function') throw new TypeError('Invalid transaction adapter');
      const now = clock();
      const window = getWindow(now);
      const snapshot = await tx.load({ now, window });
      if (!snapshot || !['manual', 'auto', 'smart_auto'].includes(snapshot.mode)) throw new TypeError('Invalid mission mode');
      if (snapshot.mode !== 'smart_auto') return { mode: snapshot.mode, handled: false };
      const { group, language, templates, previous, dailyAssignedIds, completedIds, readIds, exposureHistory, unavailableIds } = snapshot;
      if (!['khmer', 'international'].includes(group)) throw new TypeError('Invalid reader group');
      const input = { readerId, language, now, templates, previous, dailyAssignedIds, completedIds, readIds, exposureHistory, unavailableIds, candidates: [] };
      let planned = planMissions(input);
      if (planned.needsCandidates) {
        const candidates = await getCandidates({ group, language });
        planned = planMissions({ ...input, candidates });
      }
      const changed = !isDeepStrictEqual(previous, planned.missions) || !isDeepStrictEqual([...new Set(dailyAssignedIds)].sort(), [...planned.dailyAssignedIds].sort()) || planned.invalidated.length > 0;
      if (changed) await tx.save({ now, window, missions: planned.missions, created: planned.created, invalidated: planned.invalidated, dailyAssignedIds: planned.dailyAssignedIds });
      return { mode: 'smart_auto', handled: true, missions: planned.missions, windowStart: window.start, windowEnd: window.end };
    });
  };
}

module.exports = { createSmartAutoService };
