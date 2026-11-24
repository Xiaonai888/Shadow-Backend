const { getWindow, MAX_MISSIONS, MAX_DAILY_STORIES } = require('./policy.cjs');
const { selectStories } = require('./select.cjs');

const LOCKED = new Set(['in_progress', 'claimable']);
const STATUSES = new Set(['assigned', 'in_progress', 'claimable', 'claimed', 'expired', 'invalid']);

function planMissions(input) {
  const { readerId, language, now, templates, candidates, previous, dailyAssignedIds, completedIds, readIds, exposureHistory, unavailableIds } = input;
  if (!readerId || !language || !Array.isArray(templates) || templates.length > MAX_MISSIONS || !Array.isArray(previous) || previous.length > MAX_MISSIONS || !Array.isArray(dailyAssignedIds) || !Array.isArray(candidates) || !Array.isArray(completedIds) || !Array.isArray(readIds) || !Array.isArray(exposureHistory) || !Array.isArray(unavailableIds)) throw new TypeError('Invalid mission input');
  const window = getWindow(now);
  const templateIds = new Set();
  for (const template of templates) {
    if (!template || typeof template.slotId !== 'string' || !template.slotId || templateIds.has(template.slotId) || !Number.isSafeInteger(template.rewardCoins) || template.rewardCoins < 0 || !Number.isFinite(template.targetMinutes) || template.targetMinutes <= 0) throw new TypeError('Invalid mission template');
    templateIds.add(template.slotId);
  }
  const priorSlots = new Set();
  for (const mission of previous) {
    if (!mission || typeof mission.slotId !== 'string' || typeof mission.storyId !== 'string' || priorSlots.has(mission.slotId) || !STATUSES.has(mission.status) || !Number.isFinite(mission.windowStart)) throw new TypeError('Invalid previous mission');
    priorSlots.add(mission.slotId);
  }
  const unavailable = new Set(unavailableIds);
  const completed = new Set(completedIds);
  const assigned = new Set(dailyAssignedIds);
  const keep = [];
  const invalidated = [];
  for (const mission of previous) {
    if (mission.windowStart >= window.dayStart && mission.windowStart < window.dayEnd) assigned.add(mission.storyId);
    const locked = LOCKED.has(mission.status);
    const expired = mission.status === 'in_progress' && Number.isFinite(mission.expiresAt) && mission.expiresAt <= now;
    if (mission.status === 'claimable') { keep.push(mission); continue; }
    if (unavailable.has(mission.storyId) || expired) {
      invalidated.push({ slotId: mission.slotId, storyId: mission.storyId, reason: expired ? 'expired' : 'unavailable' });
      continue;
    }
    if (locked || (mission.windowStart === window.start && mission.status === 'claimed') || (mission.windowStart === window.start && mission.status === 'assigned' && mission.language === language && templateIds.has(mission.slotId) && !completed.has(mission.storyId))) keep.push(mission);
  }
  for (const mission of keep) assigned.add(mission.storyId);
  const occupied = new Set(keep.map(m => m.slotId));
  const free = templates.filter(t => !occupied.has(t.slotId)).slice(0, Math.max(0, MAX_MISSIONS - keep.length));
  const limit = Math.min(free.length, Math.max(0, MAX_DAILY_STORIES - assigned.size));
  const selected = selectStories({ readerId, language, now, windowStart: window.start, candidates, completedIds, readIds, exposureHistory, excludeIds: [...assigned, ...unavailable], limit });
  const created = selected.map((storyId, i) => ({ slotId: free[i].slotId, storyId, language, rewardCoins: free[i].rewardCoins, targetMinutes: free[i].targetMinutes, windowStart: window.start, status: 'assigned' }));
  for (const mission of created) assigned.add(mission.storyId);
  const missions = [...keep, ...created].sort((a, b) => a.slotId.localeCompare(b.slotId));
  return { window, missions, created, invalidated, dailyAssignedIds: [...assigned], needsCandidates: missions.length < templates.length && assigned.size < MAX_DAILY_STORIES };
}

module.exports = { planMissions };
