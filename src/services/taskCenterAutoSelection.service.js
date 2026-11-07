import { supabase } from '../config/supabase.js'
import { invalidateActiveSessionMissionsCache } from './taskCenterMissionCache.service.js'

// Shared implementation for Khmer and International Task Center auto rotation.
// A story must have five PUBLISHED episodes and an episode published in the
// last 30 rolling days. Metadata edits and drafts do not count as activity.
const SETTING_KEY = 'main'
const MIN_PUBLISHED_EPISODES = 5
const SHORT_MAX_EPISODES = 9
const MISSION_LIMIT = 2
const COOLDOWN_DAYS = 7
const ACTIVITY_DAYS = 30
const MAX_STORIES = 5000
const MAX_HISTORY = 10000
const EPISODE_PAGE_SIZE = 1000

// Short completed 5-9 episode stories get only a small share when other
// eligible groups exist. Ongoing novels with 5-9 episodes are treated as
// growing long novels; finished novels with 5-9 episodes are short.
const STORY_GROUPS = [
  { key: 'long_novel', weight: 80 },
  { key: 'other', weight: 10 },
  { key: 'short_completed', weight: 10 },
]

// Select a view band first *within the chosen story group*. High-view stories
// never outrank a low-view story merely because of a fresh publish date.
const VIEW_TIERS = [
  { maxViews: 100, weight: 50 },
  { maxViews: 500, weight: 30 },
  { maxViews: 2000, weight: 15 },
  { maxViews: Infinity, weight: 5 },
]

function dayInPhnomPenh(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Phnom_Penh',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  const field = (name) => parts.find((part) => part.type === name)?.value || ''
  return `${field('year')}-${field('month')}-${field('day')}`
}

function timeOf(value) {
  const ms = value ? Date.parse(value) : 0
  return Number.isFinite(ms) ? ms : 0
}

function statusOf(story) {
  return String(story?.story_status || '').trim().toLowerCase()
}

function viewsOf(story) {
  const value = Number(story?.total_views)
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function episodeCountOf(story) {
  const value = Number(story?.total_episodes)
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function storyGroup(story) {
  const episodes = episodeCountOf(story)
  if (episodes >= MIN_PUBLISHED_EPISODES && episodes <= SHORT_MAX_EPISODES && statusOf(story) === 'completed') {
    return 'short_completed'
  }
  if (String(story?.story_type || 'novel').trim().toLowerCase() === 'novel') {
    return 'long_novel'
  }
  return 'other'
}

function eligibleMetadata(story, language) {
  if (!story?.id || !String(story.title || '').trim()) return false
  if (story.story_language !== language || story.status !== 'published' || story.deleted_at) return false
  if (story.is_adult || story.is_shadow_exclusive) return false
  const episodes = episodeCountOf(story)
  if (episodes < MIN_PUBLISHED_EPISODES) return false
  // Non-novels with 5-9 episodes are short; only completed ones qualify.
  if (episodes <= SHORT_MAX_EPISODES && statusOf(story) !== 'completed' &&
      String(story.story_type || 'novel').toLowerCase() !== 'novel') return false
  return true
}

function weightedRandom(items, weightOf) {
  if (!items.length) return null
  const weights = items.map((item) => Math.max(0, Number(weightOf(item)) || 0))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  if (!(total > 0)) return items[Math.floor(Math.random() * items.length)] || null
  let ticket = Math.random() * total
  for (let i = 0; i < items.length; i += 1) {
    ticket -= weights[i]
    if (ticket < 0) return items[i]
  }
  return items[items.length - 1]
}

function pickLowViewStory(stories, lastSelectedMap) {
  const groups = STORY_GROUPS.map((group) => ({
    ...group,
    stories: stories.filter((story) => storyGroup(story) === group.key),
  })).filter((group) => group.stories.length)
  const group = weightedRandom(groups, (item) => item.weight)
  if (!group) return null

  const tiers = VIEW_TIERS.map((tier, index) => ({
    ...tier,
    stories: group.stories.filter((story) => {
      const lower = index ? VIEW_TIERS[index - 1].maxViews + 1 : 0
      const views = viewsOf(story)
      return views >= lower && views <= tier.maxViews
    }),
  })).filter((tier) => tier.stories.length)
  const tier = weightedRandom(tiers, (item) => item.weight)
  if (!tier) return null

  return weightedRandom(tier.stories, (story) => {
    const perEpisode = viewsOf(story) / Math.max(MIN_PUBLISHED_EPISODES, episodeCountOf(story))
    const lowViewWeight = 1 / (1 + Math.log1p(perEpisode) * 0.35)
    const neverPickedBonus = lastSelectedMap.has(String(story.id)) ? 1 : 1.2
    return lowViewWeight * neverPickedBonus
  })
}

async function getSettings(config) {
  const columns = ['setting_key', config.modeField, config.dateField, config.atField].join(', ')
  const { data, error } = await supabase.from('task_center_settings')
    .select(columns).eq('setting_key', SETTING_KEY).maybeSingle()
  if (error) throw error
  if (!data) throw new Error('Task Center Auto settings row is missing')
  return data
}

async function getMissions(audience) {
  const { data, error } = await supabase.from('task_center_reading_missions')
    .select('*').eq('audience', audience)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(MISSION_LIMIT + 1)
  if (error) throw error
  if ((data || []).length !== MISSION_LIMIT) {
    throw new Error(`${audience} Auto requires exactly ${MISSION_LIMIT} reading missions`)
  }
  return data
}

async function getStories(language) {
  // Apply language before the view-sorted limit: no cross-language bleed.
  const { data, error } = await supabase.from('stories')
    .select('id, title, story_type, story_language, story_status, status, deleted_at, is_shadow_exclusive, is_adult, total_episodes, total_views, updated_at')
    .eq('story_language', language)
    .eq('status', 'published')
    .is('deleted_at', null)
    .gte('total_episodes', MIN_PUBLISHED_EPISODES)
    .order('total_views', { ascending: true, nullsFirst: false })
    .limit(MAX_STORIES)
  if (error) throw error
  return (data || []).filter((story) => eligibleMetadata(story, language))
}

async function recentPublishedStoryMap(now) {
  // Query the episodes table itself, not story.updated_at or an RPC limited
  // to the top N updates per day. This avoids stale/abandoned story picks.
  const cutoffIso = new Date(now.getTime() - ACTIVITY_DAYS * 86400000).toISOString()
  const updates = new Map()
  for (let offset = 0; ; offset += EPISODE_PAGE_SIZE) {
    const { data, error } = await supabase.from('episodes')
      .select('id, story_id, published_at')
      .eq('status', 'published')
      .is('deleted_at', null)
      .gte('published_at', cutoffIso)
      .order('published_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + EPISODE_PAGE_SIZE - 1)
    if (error) throw error
    const rows = data || []
    for (const row of rows) {
      const id = String(row.story_id || '')
      if (id && !updates.has(id) && timeOf(row.published_at) >= timeOf(cutoffIso)) {
        updates.set(id, row.published_at)
      }
    }
    if (rows.length < EPISODE_PAGE_SIZE) break
  }
  return updates
}

async function hasFivePublishedEpisodes(story, verifiedMap) {
  const id = String(story?.id || '')
  if (!id || episodeCountOf(story) < MIN_PUBLISHED_EPISODES) return false
  if (verifiedMap.has(id)) return verifiedMap.get(id)
  const { count, error } = await supabase.from('episodes')
    .select('id', { count: 'exact', head: true })
    .eq('story_id', id)
    .eq('status', 'published')
    .is('deleted_at', null)
  if (error) throw error
  const valid = Number(count || 0) >= MIN_PUBLISHED_EPISODES
  verifiedMap.set(id, valid)
  return valid
}

async function getHistory(config, missionIds) {
  const { data, error } = await supabase.from(config.historyTable)
    .select('id, featured_date, slot, story_id, mission_id, selection_source, story_status, story_updated_at, selected_at')
    .in('mission_id', missionIds)
    .order('selected_at', { ascending: false })
    .limit(MAX_HISTORY)
  if (error) throw error
  return data || []
}

function lastSelectedMapOf(history) {
  const map = new Map()
  for (const row of history) {
    const id = String(row.story_id || '')
    if (!id) continue
    if (!map.has(id) || timeOf(row.selected_at) > timeOf(map.get(id).selected_at)) {
      map.set(id, row)
    }
  }
  return map
}

function chooseStory(stories, chosenIds, lastSelectedMap, cooldownCutoff) {
  const remaining = stories.filter((story) => !chosenIds.has(String(story.id)))
  if (!remaining.length) return null
  const cooled = remaining.filter((story) => {
    const previous = lastSelectedMap.get(String(story.id))
    return !previous || timeOf(previous.selected_at) < cooldownCutoff
  })
  // Recycle only if all alternatives are in the cooldown window.
  const pool = cooled.length ? cooled : remaining
  const story = pickLowViewStory(pool, lastSelectedMap)
  if (!story) return null
  const id = String(story.id)
  const source = !lastSelectedMap.has(id)
    ? 'unseen'
    : statusOf(story) === 'completed' ? 'completed' : 'recycle'
  return { story, source }
}

async function chooseVerifiedStory(stories, selectedIds, lastSelectedMap, cooldownCutoff, verifiedMap) {
  const rejected = new Set()
  // No arbitrary 30-attempt limit: try the remaining active candidates until
  // we find a story with 5 actually published episodes or exhaust the pool.
  while (rejected.size < stories.length) {
    const excluded = new Set([...selectedIds, ...rejected])
    const picked = chooseStory(stories, excluded, lastSelectedMap, cooldownCutoff)
    if (!picked) return null
    if (await hasFivePublishedEpisodes(picked.story, verifiedMap)) return picked
    rejected.add(String(picked.story.id))
  }
  return null
}

async function applySelections(config, selections, missions, nowIso) {
  for (const selection of selections) {
    const mission = missions[selection.slot - 1]
    const minutes = Math.max(1, Number(mission.target_minutes || 1))
    const { data, error } = await supabase.from('task_center_reading_missions')
      .update({
        is_active: true,
        title: `Read ${minutes} minutes`,
        subtitle: String(selection.story.title || '').trim(),
        story_link: `/story/${selection.story.id}`,
        updated_at: nowIso,
      })
      .eq('id', mission.id).eq('audience', config.audience)
      .select('id').maybeSingle()
    if (error) throw error
    if (!data) throw new Error(`Task Center ${config.audience} mission is missing`)
  }
}

async function stampRotation(config, day, nowIso) {
  const { data, error } = await supabase.from('task_center_settings')
    .update({ [config.dateField]: day, [config.atField]: nowIso, updated_at: nowIso })
    .eq('setting_key', SETTING_KEY)
    .select('setting_key').maybeSingle()
  if (error) throw error
  if (!data) throw new Error(`Failed to stamp ${config.audience} auto rotation`)
}

function toPublic(selection) {
  return {
    slot: selection.slot,
    mission_id: selection.mission_id,
    story_id: String(selection.story.id),
    story_title: selection.story.title,
    story_status: selection.story.story_status || null,
    story_link: `/story/${selection.story.id}`,
    selection_source: selection.source,
  }
}

export function createTaskCenterAutoRotation(config) {
  const { audience, language, historyTable, modeField, dateField, atField } = config
  if (!audience || !language || !historyTable || !modeField || !dateField || !atField) {
    throw new Error('Invalid Task Center Auto configuration')
  }
  let rotating = null
  let ensuring = null
  let lastEnsure = { day: '', until: 0 }

  async function rotate({ force = false } = {}) {
    if (rotating) return rotating
    const job = (async () => {
      const now = new Date()
      const nowIso = now.toISOString()
      const day = dayInPhnomPenh(now)
      const settings = await getSettings(config)
      if (!force && settings[modeField] !== 'auto') {
        return { rotated: false, reason: 'manual_mode', date: day, selections: [] }
      }
      if (!force && String(settings[dateField] || '') === day) {
        return { rotated: false, reason: 'already_rotated', date: day, selections: [] }
      }

      const missions = await getMissions(audience)
      const missionIds = missions.map((row) => row.id)
      const [allStories, recentUpdates, history] = await Promise.all([
        getStories(language), recentPublishedStoryMap(now), getHistory(config, missionIds),
      ])
      const stories = allStories.filter((story) => recentUpdates.has(String(story.id)))
      if (stories.length < MISSION_LIMIT) {
        throw new Error(`${audience} Auto: fewer than ${MISSION_LIMIT} active ${language} stories have 5+ episodes`)
      }
      const storyById = new Map(stories.map((story) => [String(story.id), story]))
      const publishedCountCache = new Map()
      const today = history.filter((row) => String(row.featured_date) === day)
      const invalidToday = []
      const usedSlots = new Set()
      const usedIds = new Set()
      const selections = []
      for (const row of today) {
        const slot = Number(row.slot)
        const id = String(row.story_id || '')
        const mission = missions[slot - 1]
        const story = storyById.get(id)
        if (!Number.isInteger(slot) || slot < 1 || slot > MISSION_LIMIT ||
            !story || !mission || String(mission.id) !== String(row.mission_id || '') ||
            usedSlots.has(slot) || usedIds.has(id) ||
            !(await hasFivePublishedEpisodes(story, publishedCountCache))) {
          invalidToday.push(row.id)
          continue
        }
        usedSlots.add(slot)
        usedIds.add(id)
        selections.push({ slot, mission_id: mission.id, story,
          source: row.selection_source || 'recycle', existing: true })
      }

      if (invalidToday.length) {
        const { error } = await supabase.from(historyTable).delete().in('id', invalidToday)
        if (error) throw error
      }
      const validHistory = history.filter((row) => !invalidToday.includes(row.id))
      const lastSelectedMap = lastSelectedMapOf(validHistory)
      const cutoff = now.getTime() - COOLDOWN_DAYS * 86400000
      for (let slot = 1; slot <= MISSION_LIMIT; slot += 1) {
        if (selections.some((row) => row.slot === slot)) continue
        const chosenIds = new Set(selections.map((row) => String(row.story.id)))
        const picked = await chooseVerifiedStory(stories, chosenIds, lastSelectedMap, cutoff, publishedCountCache)
        if (!picked) {
          throw new Error(`${audience} Auto: no more active ${language} stories with 5 published episodes`)
        }
        selections.push({ slot, mission_id: missions[slot - 1].id,
          story: picked.story, source: picked.source, existing: false })
      }
      selections.sort((a, b) => a.slot - b.slot)
      const newSelections = selections.filter((item) => !item.existing)
      if (newSelections.length) {
        const rows = newSelections.map((item) => ({
          featured_date: day, slot: item.slot, story_id: String(item.story.id),
          mission_id: String(item.mission_id), selection_source: item.source,
          story_status: item.story.story_status || null,
          story_updated_at: recentUpdates.get(String(item.story.id)) || item.story.updated_at || null,
          selected_at: nowIso,
        }))
        const { error } = await supabase.from(historyTable).insert(rows)
        if (error) {
          if (String(error.code || '') !== '23505') throw error
          // Another Render worker already inserted today's rows. Recheck them.
          const { data: concurrent, error: concurrentError } = await supabase.from(historyTable)
            .select('*').eq('featured_date', day).in('mission_id', missionIds)
            .order('slot', { ascending: true })
          if (concurrentError) throw concurrentError
          const ids = new Set()
          const slots = new Set()
          const recovered = []
          for (const row of concurrent || []) {
            const slot = Number(row.slot)
            const id = String(row.story_id || '')
            const story = storyById.get(id)
            if (!Number.isInteger(slot) || slot < 1 || slot > MISSION_LIMIT ||
                !story || !missions[slot - 1] ||
                String(row.mission_id || '') !== String(missions[slot - 1].id) ||
                ids.has(id) || slots.has(slot) ||
                !(await hasFivePublishedEpisodes(story, publishedCountCache))) continue
            ids.add(id); slots.add(slot)
            recovered.push({ slot, mission_id: row.mission_id, story,
              source: row.selection_source || 'recycle', existing: true })
          }
          if (recovered.length !== MISSION_LIMIT) {
            throw new Error(`${audience} Auto: concurrent selections are invalid`)
          }
          selections.splice(0, selections.length, ...recovered.sort((a, b) => a.slot - b.slot))
        }
      }
      await applySelections(config, selections, missions, nowIso)
      invalidateActiveSessionMissionsCache(audience)
      await stampRotation(config, day, nowIso)
      return {
        rotated: newSelections.length > 0,
        reason: newSelections.length > 0 ? 'rotated' : 'already_rotated',
        date: day,
        selections: selections.map(toPublic),
      }
    })()
    rotating = job
    try { return await job } finally { if (rotating === job) rotating = null }
  }

  async function ensure() {
    if (ensuring) return ensuring
    const day = dayInPhnomPenh()
    if (lastEnsure.day === day && Date.now() < lastEnsure.until) return
    const job = (async () => {
      const settings = await getSettings(config)
      if (settings[modeField] !== 'auto') return
      if (String(settings[dateField] || '') === day) return
      return rotate()
    })()
    ensuring = job
    try {
      const result = await job
      lastEnsure = { day: dayInPhnomPenh(), until: Date.now() + 10000 }
      return result
    } finally {
      if (ensuring === job) ensuring = null
    }
  }

  return { rotate, ensure }
}
