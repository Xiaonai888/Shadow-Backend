import { supabase } from '../config/supabase.js'
import { invalidateActiveSessionMissionsCache } from './taskCenterMissionCache.service.js'

const SETTING_KEY = 'main'
const AUTO_MODE = 'auto'
const MISSION_LIMIT = 2
const KHMER_AUDIENCE = 'khmer'
const RECENT_COOLDOWN_DAYS = 7
const MIN_EPISODES = 5
// Completed 1-4 episode stories are allowed, but limited to 10% of selections
// while standard (5+ episode) stories are available.
const SHORT_STORY_SHARE = 0.10
// Prefer stories with fewer total views. Shares are rebalanced if a band is empty.
const VIEW_TIERS = [
  { maxViews: 100, weight: 50 },
  { maxViews: 500, weight: 30 },
  { maxViews: 2000, weight: 15 },
  { maxViews: Infinity, weight: 5 },
]

function getPhnomPenhDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Phnom_Penh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)

  const year = parts.find((part) => part.type === 'year')?.value
  const month = parts.find((part) => part.type === 'month')?.value
  const day = parts.find((part) => part.type === 'day')?.value

  return `${year}-${month}-${day}`
}

function normalizeStoryStatus(value) {
  return String(value || '').trim().toLowerCase()
}

function safeViews(story) {
  const views = Number(story?.total_views)
  return Number.isFinite(views) ? Math.max(0, views) : 0
}

function isShortStory(story) {
  const episodes = Number(story?.total_episodes || 0)
  return episodes > 0 && episodes < MIN_EPISODES
}

function weightedRandom(rows, getWeight) {
  if (!rows.length) return null
  const weights = rows.map((row) => Math.max(0, Number(getWeight(row)) || 0))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  if (total <= 0) return rows[Math.floor(Math.random() * rows.length)] || null

  let ticket = Math.random() * total
  for (let i = 0; i < rows.length; i += 1) {
    ticket -= weights[i]
    if (ticket < 0) return rows[i]
  }
  return rows[rows.length - 1]
}

function pickLowViewStory(stories, lastSelectedMap, recentUpdateMap) {
  // Short stories never flood the daily missions even if there are many of them.
  const standard = stories.filter((story) => !isShortStory(story))
  const short = stories.filter(isShortStory)
  const candidatePool = standard.length && short.length
    ? (Math.random() < SHORT_STORY_SHARE ? short : standard)
    : (standard.length ? standard : short)

  const availableTiers = VIEW_TIERS.map((tier, index) => ({
    weight: tier.weight,
    stories: candidatePool.filter((story) => {
      const views = safeViews(story)
      const min = index === 0 ? 0 : VIEW_TIERS[index - 1].maxViews + 1
      return views >= min && views <= tier.maxViews
    }),
  })).filter((tier) => tier.stories.length > 0)

  const selectedTier = weightedRandom(availableTiers, (tier) => tier.weight)
  if (!selectedTier) return null

  // Views per episode are a secondary tie-breaker within the selected tier.
  // Never let a recently updated high-view story override the low-view tier.
  return weightedRandom(selectedTier.stories, (story) => {
    const episodes = Math.max(1, Number(story.total_episodes) || 1)
    const viewsPerEpisode = safeViews(story) / episodes
    const lowViewWeight = 1 / (1 + Math.log1p(viewsPerEpisode) * 0.35)
    const unseenBonus = lastSelectedMap.has(String(story.id)) ? 1 : 1.2
    const updateBonus = recentUpdateMap.has(String(story.id)) ? 1.05 : 1
    return lowViewWeight * unseenBonus * updateBonus
  })
}

function toTime(value) {
  const time = value ? new Date(value).getTime() : 0
  return Number.isFinite(time) ? time : 0
}

async function getAutoSettings() {
  const { data, error } = await supabase
    .from('task_center_settings')
    .select('setting_key, reading_mission_mode, auto_last_rotation_date, auto_last_rotated_at')
    .eq('setting_key', SETTING_KEY)
    .maybeSingle()

  if (error) throw error

  return data || {
    setting_key: SETTING_KEY,
    reading_mission_mode: 'manual',
    auto_last_rotation_date: null,
    auto_last_rotated_at: null,
  }
}

async function getMissionRows() {
  const { data, error } = await supabase
    .from('task_center_reading_missions')
    .select('*')
    .eq('audience', KHMER_AUDIENCE)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(MISSION_LIMIT)

  if (error) throw error

  const rows = data || []

  if (rows.length !== MISSION_LIMIT) {
    throw new Error('Auto reading mission requires exactly 2 existing missions')
  }

  return rows
}

async function getEligibleStories() {
  const { data, error } = await supabase
    .from('stories')
    .select('id, title, story_status, status, deleted_at, is_shadow_exclusive, is_adult, total_episodes, total_views, created_at, updated_at')
    .eq('status', 'published')
    .is('deleted_at', null)
    .order('total_views', { ascending: true, nullsFirst: false })
    .limit(5000)

  if (error) throw error

  return (data || []).filter((story) => {
    if (!story?.id) return false
    if (!String(story.title || '').trim()) return false
    if (Boolean(story.is_shadow_exclusive)) return false
    if (Boolean(story.is_adult)) return false
    const episodes = Number(story.total_episodes || 0)
    if (episodes < 1) return false
    if (isShortStory(story) && normalizeStoryStatus(story.story_status) !== 'completed') return false
    return true
  })
}

async function getRecentUpdateMap() {
  const { data, error } = await supabase.rpc('get_public_story_updates', {
    p_language: null,
    p_story_type: null,
    p_include_adult: false,
    p_days: 7,
    p_limit_per_day: 100,
  })

  if (error) {
    console.error('TASK CENTER AUTO UPDATE SOURCE ERROR:', error)
    return new Map()
  }

  const map = new Map()

  for (const item of data || []) {
    const storyId = String(item?.id || '').trim()
    if (!storyId) continue

    const current = map.get(storyId)
    const nextTime = toTime(item?.last_episode_published_at)
    const currentTime = toTime(current?.last_episode_published_at)

    if (!current || nextTime > currentTime) {
      map.set(storyId, item)
    }
  }

  return map
}

async function getHistoryRows(missionIds) {
  const { data, error } = await supabase
    .from('task_center_auto_story_history')
    .select('id, featured_date, slot, story_id, mission_id, selection_source, story_status, story_updated_at, selected_at')
    .in('mission_id', missionIds)
    .order('selected_at', { ascending: false })
    .limit(10000)

  if (error) throw error

  return data || []
}

function buildLastSelectedMap(historyRows = []) {
  const map = new Map()

  for (const row of historyRows) {
    const storyId = String(row?.story_id || '').trim()
    if (!storyId) continue

    const previous = map.get(storyId)
    if (!previous || toTime(row.selected_at) > toTime(previous.selected_at)) {
      map.set(storyId, row)
    }
  }

  return map
}

function pickStory({
  stories,
  selectedStoryIds,
  lastSelectedMap,
  recentUpdateMap,
  cooldownCutoff,
}) {
  const available = stories.filter((story) => !selectedStoryIds.has(String(story.id)))
  if (!available.length) return null

  // Avoid repeating a story within seven days whenever alternatives exist.
  const outsideCooldown = available.filter((story) => {
    const history = lastSelectedMap.get(String(story.id))
    return !history || toTime(history.selected_at) < cooldownCutoff
  })
  const pool = outsideCooldown.length ? outsideCooldown : available
  const story = pickLowViewStory(pool, lastSelectedMap, recentUpdateMap)
  if (!story) return null

  const id = String(story.id)
  const source = !lastSelectedMap.has(id)
    ? 'unseen'
    : recentUpdateMap.has(id)
      ? 'updated'
      : normalizeStoryStatus(story.story_status) === 'completed'
        ? 'completed'
        : 'recycle'

  return { story, source }
}

async function deleteInvalidTodayRows(rows = []) {
  const ids = rows.map((row) => row?.id).filter(Boolean)
  if (ids.length === 0) return

  const { error } = await supabase
    .from('task_center_auto_story_history')
    .delete()
    .in('id', ids)

  if (error) throw error
}

async function insertHistoryRows(rows = []) {
  if (rows.length === 0) return []

  const { data, error } = await supabase
    .from('task_center_auto_story_history')
    .insert(rows)
    .select('*')

  if (error) throw error
  return data || []
}

async function applySelectionsToMissions(selections, missions, nowIso) {
  const results = []

  for (const selection of selections) {
    const mission = missions[selection.slot - 1]
    const targetMinutes = Math.max(1, Number(mission?.target_minutes || 1))
    const storyTitle = String(selection.story.title || '').trim()

    const { data, error } = await supabase
      .from('task_center_reading_missions')
      .update({
        is_active: true,
        title: `Read ${targetMinutes} minutes`,
        subtitle: storyTitle,
        story_link: `/story/${selection.story.id}`,
        updated_at: nowIso,
      })
      .eq('id', mission.id)
      .eq('audience', KHMER_AUDIENCE)
      .select('*')
      .single()

    if (error) throw error
    results.push(data)
  }

  return results
}

async function updateRotationStamp(dateKey, nowIso) {
  const { error } = await supabase
    .from('task_center_settings')
    .update({
      auto_last_rotation_date: dateKey,
      auto_last_rotated_at: nowIso,
      updated_at: nowIso,
    })
    .eq('setting_key', SETTING_KEY)

  if (error) throw error
}

function publicSelection(selection) {
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

let taskCenterRotationCheck = null
let taskCenterRotationLastCheck = { date: '', until: 0 }

export async function ensureTaskCenterAutoRotation() {
  if (taskCenterRotationCheck) return taskCenterRotationCheck

  const today = getPhnomPenhDateKey()
  if (taskCenterRotationLastCheck.date === today && Date.now() < taskCenterRotationLastCheck.until) return

  const check = (async () => {
    const settings = await getAutoSettings()
    const dateKey = getPhnomPenhDateKey()

    if (settings.reading_mission_mode !== 'auto') return
    if (String(settings.auto_last_rotation_date || '') === dateKey) return

    return rotateTaskCenterAutoStories()
  })()

  taskCenterRotationCheck = check

  try {
    const result = await check
    taskCenterRotationLastCheck = { date: getPhnomPenhDateKey(), until: Date.now() + 10_000 }
    return result
  } finally {
    if (taskCenterRotationCheck === check) {
      taskCenterRotationCheck = null
    }
  }
}


export async function rotateTaskCenterAutoStories({ force = false } = {}) {
  const now = new Date()
  const nowIso = now.toISOString()
  const dateKey = getPhnomPenhDateKey(now)
  const settings = await getAutoSettings()

  if (!force && String(settings.reading_mission_mode || 'manual') !== AUTO_MODE) {
    return {
      rotated: false,
      reason: 'manual_mode',
      date: dateKey,
      selections: [],
    }
  }

  const missions = await getMissionRows()
  const missionIds = missions.map((mission) => mission.id)
  const [stories, recentUpdateMap, historyRows] = await Promise.all([
    getEligibleStories(),
    getRecentUpdateMap(),
    getHistoryRows(missionIds),
  ])

  // Include all eligible published stories, not only recent updates or completed ones.
  // Otherwise low-view ongoing stories that have not updated recently disappear.
  const recommendationStories = stories

  if (recommendationStories.length < MISSION_LIMIT) {
    throw new Error('Auto reading mission requires at least 2 eligible published stories')
  }

  const storyMap = new Map(
    recommendationStories.map((story) => [String(story.id), story])
  )
  const todayRows = historyRows.filter((row) => String(row.featured_date) === dateKey)
  const validTodayRows = []
  const invalidTodayRows = []
  const usedSlots = new Set()
  const usedStoryIds = new Set()

  for (const row of todayRows) {
    const slot = Number(row.slot)
    const storyId = String(row.story_id || '')
    const story = storyMap.get(storyId)

    if (
      !story ||
      ![1, 2].includes(slot) ||
      usedSlots.has(slot) ||
      usedStoryIds.has(storyId)
    ) {
      invalidTodayRows.push(row)
      continue
    }

    usedSlots.add(slot)
    usedStoryIds.add(storyId)
    validTodayRows.push(row)
  }

  if (invalidTodayRows.length > 0) {
    await deleteInvalidTodayRows(invalidTodayRows)
  }

  const lastSelectedMap = buildLastSelectedMap(
    historyRows.filter((row) => !invalidTodayRows.some((invalid) => invalid.id === row.id))
  )
  const cooldownCutoff = now.getTime() - RECENT_COOLDOWN_DAYS * 24 * 60 * 60 * 1000
  const selections = validTodayRows.map((row) => ({
    slot: Number(row.slot),
    mission_id: row.mission_id || missions[Number(row.slot) - 1]?.id || null,
    story: storyMap.get(String(row.story_id)),
    source: row.selection_source || 'recycle',
    existing: true,
  }))

  for (let slot = 1; slot <= MISSION_LIMIT; slot += 1) {
    if (selections.some((selection) => selection.slot === slot)) continue

    const picked = pickStory({
      stories: recommendationStories,
      selectedStoryIds: new Set(selections.map((selection) => String(selection.story.id))),
      lastSelectedMap,
      recentUpdateMap,
      cooldownCutoff,
    })

    if (!picked?.story) {
      throw new Error(`Could not select a story for auto mission slot ${slot}`)
    }

    selections.push({
      slot,
      mission_id: missions[slot - 1].id,
      story: picked.story,
      source: picked.source,
      existing: false,
    })
  }

  selections.sort((a, b) => a.slot - b.slot)

  const newSelections = selections.filter((selection) => !selection.existing)

  if (newSelections.length > 0) {
    const rows = newSelections.map((selection) => ({
      featured_date: dateKey,
      slot: selection.slot,
      story_id: String(selection.story.id),
      mission_id: String(selection.mission_id || ''),
      selection_source: selection.source,
      story_status: selection.story.story_status || null,
      story_updated_at:
        recentUpdateMap.get(String(selection.story.id))?.last_episode_published_at ||
        selection.story.updated_at ||
        null,
      selected_at: nowIso,
    }))

    try {
      await insertHistoryRows(rows)
    } catch (error) {
      if (String(error?.code || '') !== '23505') throw error

      const { data: concurrentRows, error: concurrentError } = await supabase
        .from('task_center_auto_story_history')
        .select('*')
        .eq('featured_date', dateKey)
        .in('mission_id', missionIds)
        .order('slot', { ascending: true })

      if (concurrentError) throw concurrentError

      const concurrentSelections = (concurrentRows || [])
        .map((row) => ({
          slot: Number(row.slot),
          mission_id: row.mission_id || missions[Number(row.slot) - 1]?.id || null,
          story: storyMap.get(String(row.story_id)),
          source: row.selection_source || 'recycle',
          existing: true,
        }))
        .filter((selection) => selection.story)

      if (concurrentSelections.length !== MISSION_LIMIT) throw error

      selections.splice(0, selections.length, ...concurrentSelections)
      selections.sort((a, b) => a.slot - b.slot)
    }
  }

  await applySelectionsToMissions(selections, missions, nowIso)
  invalidateActiveSessionMissionsCache()
  await updateRotationStamp(dateKey, nowIso)

  return {
    rotated: newSelections.length > 0,
    reason: newSelections.length > 0 ? 'rotated' : 'already_rotated',
    date: dateKey,
    selections: selections.map(publicSelection),
  }
}
