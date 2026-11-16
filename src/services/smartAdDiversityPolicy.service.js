const DAY_MS = 86400000
const NEW_STORY_DAYS = 30

function hash(value) {
  let number = 2166136261
  for (const char of String(value)) {
    number ^= char.charCodeAt(0)
    number = Math.imul(number, 16777619)
  }
  return number >>> 0
}

function count(value) {
  return Math.max(0, Number(value) || 0)
}

function timestamp(value) {
  const parsed = Date.parse(value || '')
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeRecentHistory(value) {
  if (value instanceof Map) return value
  if (value instanceof Set) return new Map([...value].map((id) => [String(id), 0]))
  if (Array.isArray(value)) return new Map(value.map((id) => [String(id), 0]))
  return new Map()
}

export function selectDiverseSmartAdCandidates({
  candidates = [],
  limit = 10,
  hardExcludedIds = [],
  recentHistory = new Map(),
  seed = '',
  now = Date.now(),
  shortShare = 0.10,
  allowRecentFallback = false,
  preferredScore = () => 0,
} = {}) {
  const takeCount = Math.max(1, Math.min(10, Math.trunc(Number(limit) || 10)))
  const hardExcluded = new Set(hardExcludedIds.map(String))
  const recent = normalizeRecentHistory(recentHistory)
  const unique = new Map()
  for (const story of candidates) {
    const id = String(story?.story_id || '')
    if (!id || !story?.first_episode_id || hardExcluded.has(id) || unique.has(id)) continue
    unique.set(id, story)
  }
  const available = [...unique.values()]
  if (!available.length) return []

  const views = available.map((story) => count(story.total_views)).sort((a, b) => a - b)
  const popularCutoff = views[Math.max(0, Math.floor(views.length * 0.95) - 1)] ?? Infinity
  const isPopular = (story) => available.length >= 20 && count(story.total_views) >= popularCutoff
  const maxShort = takeCount === 1
    ? (hash(`${seed}:short`) % 10 === 0 ? 1 : 0)
    : Math.max(1, Math.floor(takeCount * shortShare))
  const maxPopular = takeCount === 1
    ? (hash(`${seed}:popular`) % 20 === 0 ? 1 : 0)
    : (hash(`${seed}:popular`) % 2 === 0 ? 1 : 0)

  const result = []
  const selectedIds = new Set()
  let shorts = 0
  let popular = 0

  const pick = (stories, enforceCaps = true) => {
    for (const story of stories) {
      const id = String(story.story_id)
      if (selectedIds.has(id)) continue
      if (enforceCaps && story.story_kind === 'short' && shorts >= maxShort) continue
      if (enforceCaps && isPopular(story) && popular >= maxPopular) continue
      selectedIds.add(id)
      result.push(story)
      if (story.story_kind === 'short') shorts += 1
      if (isPopular(story)) popular += 1
      return true
    }
    return false
  }

  const sortGroups = (group) => {
    const preferred = [...group].sort((a, b) =>
      Number(preferredScore(b) || 0) - Number(preferredScore(a) || 0) ||
      hash(`${seed}:preferred:${a.story_id}`) - hash(`${seed}:preferred:${b.story_id}`))
    const discovery = [...group].sort((a, b) =>
      count(a.total_views) - count(b.total_views) ||
      hash(`${seed}:discovery:${a.story_id}`) - hash(`${seed}:discovery:${b.story_id}`))
    const fresh = group.filter((story) => {
      const published = timestamp(story.created_at)
      return published !== null && published <= now && now - published <= NEW_STORY_DAYS * DAY_MS
    }).sort((a, b) =>
      timestamp(b.created_at) - timestamp(a.created_at) ||
      hash(`${seed}:fresh:${a.story_id}`) - hash(`${seed}:fresh:${b.story_id}`))
    return { preferred, discovery, fresh }
  }

  const allocation = takeCount === 1
    ? ['preferred']
    : ['preferred', 'fresh', 'preferred', 'discovery', 'preferred', 'fresh',
      'preferred', 'discovery', 'preferred', 'preferred'].slice(0, takeCount)

  const draw = (stories) => {
    if (result.length >= takeCount || !stories.length) return
    const groups = sortGroups(stories)
    for (const category of allocation) {
      if (result.length >= takeCount) break
      pick(groups[category])
    }
    for (const story of groups.preferred) {
      if (result.length >= takeCount) break
      pick([story], false)
    }
  }

  const unseen = available.filter((story) => !recent.has(String(story.story_id)))
  const older = available.filter((story) => recent.has(String(story.story_id)))
  draw(unseen)
  if (allowRecentFallback && result.length < takeCount && older.length) {
    const oldest = [...older].sort((a, b) =>
      Number(recent.get(String(a.story_id)) || 0) - Number(recent.get(String(b.story_id)) || 0) ||
      hash(`${seed}:oldest:${a.story_id}`) - hash(`${seed}:oldest:${b.story_id}`))
    for (const story of oldest) {
      if (result.length >= takeCount) break
      pick([story], false)
    }
  }
  return result
}
