const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const ROTATION_MS = 6 * HOUR_MS;
const OFFSET_MS = 7 * HOUR_MS;
const MAX_MISSIONS = 2;
const MAX_DAILY_STORIES = 8;
const REPEAT_MS = 7 * DAY_MS;

function getWindow(now) {
  if (!Number.isFinite(now)) throw new TypeError('Invalid server time');
  const local = now + OFFSET_MS;
  const start = Math.floor(local / ROTATION_MS) * ROTATION_MS - OFFSET_MS;
  const dayStart = Math.floor(local / DAY_MS) * DAY_MS - OFFSET_MS;
  return { start, end: start + ROTATION_MS, dayStart, dayEnd: dayStart + DAY_MS };
}

module.exports = { getWindow, MAX_MISSIONS, MAX_DAILY_STORIES, REPEAT_MS };
