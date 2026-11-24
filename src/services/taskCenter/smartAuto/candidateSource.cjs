const MAX_CANDIDATES = 1000;

function createCandidateSource({ readPool }) {
  if (typeof readPool !== 'function') throw new TypeError('readPool is required');
  return async function getCandidates({ group, language }) {
    if (!['khmer', 'international'].includes(group) || typeof language !== 'string' || !language.trim()) throw new TypeError('Invalid candidate scope');
    const pool = await readPool({ group, language, limit: MAX_CANDIDATES });
    if (!Array.isArray(pool)) throw new TypeError('Invalid Discover candidate pool');
    const result = new Map();
    for (const story of pool.slice(0, MAX_CANDIDATES)) {
      if (!story || typeof story.id !== 'string' || !story.id || story.language !== language || story.eligible !== true || result.has(story.id)) continue;
      result.set(story.id, { id: story.id, language, eligible: true, views: Number.isFinite(story.views) && story.views >= 0 ? story.views : null });
    }
    return [...result.values()];
  };
}

module.exports = { createCandidateSource, MAX_CANDIDATES };
