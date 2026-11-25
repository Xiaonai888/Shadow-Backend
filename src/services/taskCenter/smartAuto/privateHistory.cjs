const { REPEAT_MS } = require('./policy.cjs');
const MAX_HISTORY = 64;
const RPC = 'task_center_smart_auto_record_exposure_v1';

function recentExposureHistory(entries, now = Date.now()) {
  if (!Array.isArray(entries) || !Number.isSafeInteger(now)) throw new TypeError('Invalid exposure history');
  const newest = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.storyId !== 'string' || !entry.storyId.trim() || !Number.isSafeInteger(entry.seenAt) || entry.seenAt < now - REPEAT_MS || entry.seenAt > now) continue;
    if (!newest.has(entry.storyId) || newest.get(entry.storyId).seenAt < entry.seenAt) newest.set(entry.storyId, { storyId: entry.storyId, seenAt: entry.seenAt });
  }
  return [...newest.values()].sort((a,b) => b.seenAt - a.seenAt || a.storyId.localeCompare(b.storyId)).slice(0, MAX_HISTORY);
}

function createPrivateHistoryRecorder({ supabase }) {
  if (typeof supabase?.rpc !== 'function') throw new TypeError('Invalid Smart Auto history dependency');
  return async function recordVisibleMissions({ readerId, mode, visibleMissions }) {
    if (mode !== 'smart_auto') return false;
    if (typeof readerId !== 'string' || !readerId.trim() || readerId.length > 128 || !Array.isArray(visibleMissions) || visibleMissions.length > 2) throw new TypeError('Invalid visible mission request');
    const unique = new Map();
    for (const item of visibleMissions) {
      if (typeof item?.storyId !== 'string' || !item.storyId.trim() || item.storyId.length > 128 || !Number.isSafeInteger(item.windowStart) || item.windowStart < 0) throw new TypeError('Invalid visible mission');
      unique.set(JSON.stringify([item.storyId,item.windowStart]), { storyId: item.storyId, windowStart: item.windowStart });
    }
    if (!unique.size) return false;
    const { data, error } = await supabase.rpc(RPC, { p_reader_id: readerId, p_visible_missions: [...unique.values()] });
    if (error) throw new Error('Smart Auto exposure save failed', { cause: error });
    if (typeof data !== 'boolean') throw new TypeError('Invalid exposure save response');
    return data;
  };
}

module.exports = { recentExposureHistory, createPrivateHistoryRecorder, MAX_HISTORY };
