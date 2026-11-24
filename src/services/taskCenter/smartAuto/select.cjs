const { createHash } = require('node:crypto');
const { REPEAT_MS } = require('./policy.cjs');

function score(readerId, start, id) {
  return createHash('sha256').update(JSON.stringify([readerId, start, id])).digest().readUInt32BE(0) / 4294967296;
}

function selectStories({ readerId, language, now, windowStart, candidates, completedIds, readIds, exposureHistory, excludeIds, limit }) {
  if (!readerId || !language || !Number.isFinite(now) || !Number.isFinite(windowStart)) throw new TypeError('Invalid selection input');
  if (!Number.isInteger(limit) || limit < 0 || limit > 2) throw new TypeError('Invalid selection limit');
  const completed = new Set(completedIds);
  const read = new Set(readIds);
  const excluded = new Set(excludeIds);
  const lastSeen = new Map();
  for (const entry of exposureHistory) {
    if (!entry || !entry.storyId || !Number.isFinite(entry.seenAt) || entry.seenAt > now) continue;
    lastSeen.set(entry.storyId, Math.max(lastSeen.get(entry.storyId) ?? -Infinity, entry.seenAt));
  }
  const unique = new Map();
  for (const story of candidates) {
    if (!story || typeof story.id !== 'string' || !story.id || story.eligible !== true || story.language !== language || completed.has(story.id) || excluded.has(story.id) || unique.has(story.id)) continue;
    const seen = lastSeen.get(story.id) ?? -Infinity;
    unique.set(story.id, { id: story.id, recent: Number(seen >= now - REPEAT_MS), read: Number(read.has(story.id)), seen, views: Number.isFinite(story.views) && story.views >= 0 ? story.views : null, random: score(readerId, windowStart, story.id) });
  }
  const sorted = [...unique.values()].sort((a, b) => a.recent - b.recent || a.read - b.read || (a.recent && a.seen !== b.seen ? a.seen - b.seen : 0) || (a.views === null ? 1 : 0) - (b.views === null ? 1 : 0) || a.random + Math.log1p(a.views ?? 0) * 0.12 - b.random - Math.log1p(b.views ?? 0) * 0.12 || a.id.localeCompare(b.id));
  return sorted.slice(0, limit).map(story => story.id);
}

module.exports = { selectStories };
