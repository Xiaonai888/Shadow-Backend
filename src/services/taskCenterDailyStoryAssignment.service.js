import { supabase } from '../config/supabase.js'

const NEW_STORY_WINDOW_DAYS = 7
const NEW_STORY_FALLBACK_LIMIT = 100
const STORY_QUERY_LIMIT = 1000
const RETRY_AFTER_MS = 5 * 60 * 1000

let assignmentCache = {
  date: '',
  value: null,
  retryAfter: 0,
}

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

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase()
}

function toTime(value) {
  const time = value ? new Date(value).getTime() : 0
  return Number.isFinite(time) ? time : 0
}

function randomItem(items = []) {
  if (!Array.isArray(items) || items.length === 0) return null
  return items[Math.floor(Math.random() * items.length)] || null
}

function publicAssignment(row) {
  if (!row?.assignment_date) return null

  const newStoryId = String(row.new_story_id || '').trim()
  const completedStoryId = String(row.completed_story_id || '').trim()

  if (!newStoryId || !completedStoryId) return null

  return {
    assignment_date: String(row.assignment_date),
    new_story_id: newStoryId,
    new_story_link: `/story/${newStoryId}`,
    completed_story_id: completedStoryId,
    completed_story_link: `/story/${completedStoryId}`,
  }
}

function cacheAssignment(dateKey, value, retryAfter = 0) {
  assignmentCache = {
    date: dateKey,
    value,
    retryAfter,
  }

  return value
}

async function loadSavedAssignment(dateKey) {
  const { data, error } = await supabase
    .from('task_center_daily_story_assignments')
    .select('assignment_date, new_story_id, completed_story_id, created_at')
    .eq('assignment_date', dateKey)
    .maybeSingle()

  if (error) throw error

  return publicAssignment(data)
}

async function loadEligibleStories() {
  const { data, error } = await supabase
    .from('stories')
    .select('id, title, story_status, status, deleted_at, is_shadow_exclusive, is_adult, total_episodes, created_at')
    .eq('status', 'published')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(STORY_QUERY_LIMIT)

  if (error) throw error

  return (data || []).filter((story) => {
    if (!story?.id) return false
    if (!String(story.title || '').trim()) return false
    if (Boolean(story.is_shadow_exclusive)) return false
    if (Boolean(story.is_adult)) return false
    if (Number(story.total_episodes || 0) < 1) return false
    return true
  })
}

function pickDailyStories(stories = []) {
  const now = Date.now()
  const recentCutoff =
    now - NEW_STORY_WINDOW_DAYS * 24 * 60 * 60 * 1000

  const notCompleted = stories.filter(
    (story) => normalizeStatus(story.story_status) !== 'completed'
  )

  const recentNewStories = notCompleted.filter(
    (story) => toTime(story.created_at) >= recentCutoff
  )

  const newPool =
    recentNewStories.length > 0
      ? recentNewStories
      : notCompleted.slice(0, NEW_STORY_FALLBACK_LIMIT)

  const newStory = randomItem(newPool)

  const completedPool = stories.filter(
    (story) =>
      normalizeStatus(story.story_status) === 'completed' &&
      String(story.id) !== String(newStory?.id || '')
  )

  const completedStory = randomItem(completedPool)

  if (!newStory || !completedStory) return null

  return {
    newStory,
    completedStory,
  }
}

async function saveAssignment(dateKey, selected) {
  const payload = {
    assignment_date: dateKey,
    new_story_id: String(selected.newStory.id),
    completed_story_id: String(selected.completedStory.id),
  }

  const { data, error } = await supabase
    .from('task_center_daily_story_assignments')
    .insert(payload)
    .select('assignment_date, new_story_id, completed_story_id, created_at')
    .single()

  if (!error) return publicAssignment(data)

  if (String(error.code || '') === '23505') {
    return loadSavedAssignment(dateKey)
  }

  throw error
}

export async function getTaskCenterDailyStoryAssignment() {
  const dateKey = getPhnomPenhDateKey()
  const now = Date.now()

  if (
    assignmentCache.date === dateKey &&
    assignmentCache.value
  ) {
    return assignmentCache.value
  }

  if (
    assignmentCache.date === dateKey &&
    !assignmentCache.value &&
    now < Number(assignmentCache.retryAfter || 0)
  ) {
    return null
  }

  const saved = await loadSavedAssignment(dateKey)

  if (saved) {
    return cacheAssignment(dateKey, saved)
  }

  const stories = await loadEligibleStories()
  const selected = pickDailyStories(stories)

  if (!selected) {
    return cacheAssignment(
      dateKey,
      null,
      Date.now() + RETRY_AFTER_MS
    )
  }

  const created = await saveAssignment(dateKey, selected)

  if (!created) {
    return cacheAssignment(
      dateKey,
      null,
      Date.now() + RETRY_AFTER_MS
    )
  }

  return cacheAssignment(dateKey, created)
}
