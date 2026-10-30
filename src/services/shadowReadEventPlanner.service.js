import { createHash } from 'node:crypto'
import { supabase } from '../config/supabase.js'

const FIRST_EVENT = '2026-11-02'
const EVENT_INTERVAL_DAYS = 28
const MAX_DAILY_CANDIDATES = 500
const MAX_FEATURED_CANDIDATES = 250
const DAYS = 7
const DAILY_MISSION_POINTS = [300, 220, 190, 160, 130]
const MILESTONE_POINTS = [200, 400, 600, 800, 1000]
const MILESTONE_COINS = [25, 50, 75, 100, 150]

export const SHADOW_READ_EVENT_PRIZES = Object.freeze({
  daily_top: [
    { rank: 1, coins: 1000, vouchers: 10 },
    { rank: 2, coins: 700, vouchers: 7 },
    { rank: 3, coins: 500, vouchers: 5 },
  ],
  overall_top: [
    { rank: 1, story_cards: 100 },
    { rank: 2, story_cards: 70 },
    { rank: 3, story_cards: 50 },
  ],
  overall_gift_box: {
    vouchers_min: 10,
    vouchers_max: 100,
    coins_min: 1000,
    coins_max: 10000,
  },
  participation: {
    story_cards: 10,
    vouchers: 10,
    coins_min: 100,
    coins_max: 1000,
  },
  story_cards_per_episode: 10,
})

const DAILY_TASKS = [
  [
    ['free_read', 3, {}],
    ['read_new', 2, { window_days: 14 }],
    ['task_coins', 100, { source: 'task_center' }],
    ['read_authors', 2, { distinct_authors: true }],
  ],
  [
    ['free_read', 3, {}],
    ['read_update', 2, { update_window_days: 14 }],
    ['read_genre', 2, { distinct_genres: true }],
    ['episode_marathon', 3, { same_story: true }],
  ],
  [
    ['read_genre', 2, { genres: ['GB', 'BL', 'GL'], match: 'any' }],
    ['free_read', 3, {}],
    ['task_coins', 100, { source: 'task_center' }],
    ['read_authors', 1, { new_author_to_reader: true }],
  ],
  [
    ['read_completed', 3, {}],
    ['free_read', 3, {}],
    ['episode_marathon', 3, { same_story: true }],
    ['read_genre', 2, { distinct_genres: true }],
  ],
  [
    ['free_read', 4, {}],
    ['task_coins', 150, { source: 'task_center' }],
    ['read_update', 2, { update_window_days: 14 }],
    ['read_authors', 3, { distinct_authors: true }],
  ],
  [
    ['free_read', 5, {}],
    ['read_completed', 3, {}],
    ['read_genre', 3, { genres: ['GB', 'BL', 'GL'], match: 'any' }],
    ['episode_marathon', 5, { same_story: true }],
  ],
  [
    ['free_read', 5, {}],
    ['read_update', 3, { update_window_days: 14, allow_new: true }],
    ['task_coins', 200, { source: 'task_center' }],
    ['episode_marathon', 10, { same_story: false }],
  ],
]

function dateNumber(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('Invalid Shadow Read Event start date')
  }
  const time = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) {
    throw new Error('Invalid Shadow Read Event start date')
  }
  return time
}

export function validateShadowReadEventStart(startsOn) {
  const daysFromFirst = (dateNumber(startsOn) - dateNumber(FIRST_EVENT)) / 86400000
  if (!Number.isInteger(daysFromFirst) || daysFromFirst < 0 || daysFromFirst % EVENT_INTERVAL_DAYS !== 0) {
    throw new Error('Shadow Read Event must start on the 28-day Monday cycle')
  }
  return startsOn
}

export function getNextShadowReadEventStart(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('Invalid date')
  }
  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Phnom_Penh',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const value = (type) => dateParts.find((part) => part.type === type)?.value
  const dateKey = `${value('year')}-${value('month')}-${value('day')}`
  const days = Math.max(0, Math.ceil((dateNumber(dateKey) - dateNumber(FIRST_EVENT)) / 86400000))
  const cycle = Math.ceil(days / EVENT_INTERVAL_DAYS)
  return new Date(dateNumber(FIRST_EVENT) + cycle * EVENT_INTERVAL_DAYS * 86400000)
    .toISOString().slice(0, 10)
}

function getRotatingTasks(startsOn, day) {
  const tasks = DAILY_TASKS[day - 1].map(([type, target, params]) => [type, target, { ...params }])
  const cycle = (dateNumber(startsOn) - dateNumber(FIRST_EVENT)) / (EVENT_INTERVAL_DAYS * 86400000)
  if (cycle === 0) return tasks

  const alternatives = DAILY_TASKS[(day - 1 + cycle) % DAYS]
    .filter(([type]) => !tasks.some(([existing]) => existing === type))
  const replaceable = tasks.map(([type], index) =>
    type !== 'free_read' && type !== 'task_coins' ? index : -1
  ).filter((index) => index >= 0)

  if (alternatives.length && replaceable.length) {
    const replaceIndex = replaceable[(cycle + day) % replaceable.length]
    const [type, target, params] = alternatives[(cycle + day) % alternatives.length]
    tasks[replaceIndex] = [type, target, { ...params }]
  }
  return tasks
}

function safeStory(row, minimumEpisodes = 2) {
  return Boolean(
    row && row.id && String(row.title || '').trim() &&
    Number(row.total_episodes || 0) >= minimumEpisodes &&
    String(row.status || '').toLowerCase() === 'published' &&
    !row.deleted_at && !row.is_adult && !row.is_shadow_exclusive &&
    (!row.admin_visibility_status || row.admin_visibility_status === 'active')
  )
}

function makeRng(startsOn) {
  let seed = createHash('sha256').update(`shadow-read-event:${startsOn}`).digest().readUInt32BE(0) || 1
  return () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 4294967296
  }
}

function chooseWeighted(stories, usedIds, recentIds, random) {
  const eligible = stories.filter((story) => !usedIds.has(String(story.id)))
  if (!eligible.length) throw new Error('Not enough eligible stories for 7 daily missions and 1 featured story')
  const weights = eligible.map((story) => {
    const views = Math.max(0, Number(story.total_views) || 0)
    const underReadWeight = 1 / (1 + Math.log1p(views) * 0.7)
    const recentPenalty = recentIds.has(String(story.id)) ? 0.08 : 1
    return Math.max(0.0001, underReadWeight * recentPenalty)
  })
  const totalWeight = weights.reduce((sum, value) => sum + value, 0)
  let ticket = random() * totalWeight
  for (let i = 0; i < eligible.length; i += 1) {
    ticket -= weights[i]
    if (ticket < 0) return eligible[i]
  }
  return eligible[eligible.length - 1]
}

async function fetchCandidates(startsOn) {
  const columns = 'id,title,story_status,status,deleted_at,is_adult,is_shadow_exclusive,admin_visibility_status,access_type,total_episodes,total_views,created_at'
  const [dailyResult, featuredResult, historyResult] = await Promise.all([
    supabase.from('stories').select(columns)
      .eq('status', 'published').is('deleted_at', null)
      .gte('total_episodes', 2)
      .order('total_views', { ascending: true })
      .limit(MAX_DAILY_CANDIDATES),
    supabase.from('stories').select(columns)
      .eq('status', 'published').is('deleted_at', null)
      .ilike('story_status', 'completed').gte('total_episodes', 10)
      .order('total_views', { ascending: true })
      .limit(MAX_FEATURED_CANDIDATES),
    supabase.from('shadow_read_event_weeks')
      .select('id,starts_on,featured_story_id')
      .lt('starts_on', startsOn)
      .order('starts_on', { ascending: false })
      .limit(6),
  ])
  for (const result of [dailyResult, featuredResult, historyResult]) {
    if (result.error) throw result.error
  }
  const previousWeeks = historyResult.data || []
  let priorDailyStories = []
  if (previousWeeks.length) {
    const { data, error } = await supabase.from('shadow_read_event_missions')
      .select('event_id,story_id')
      .in('event_id', previousWeeks.map((row) => row.id))
      .eq('slot', 1)
      .limit(42)
    if (error) throw error
    priorDailyStories = data || []
  }
  return {
    daily: (dailyResult.data || []).filter((row) =>
      safeStory(row) && String(row.access_type || 'free').toLowerCase() === 'free'),
    featured: (featuredResult.data || []).filter((row) =>
      safeStory(row, 10) && String(row.story_status || '').toLowerCase() === 'completed'),
    recentIds: new Set([
      ...previousWeeks.map((row) => String(row.featured_story_id)),
      ...priorDailyStories.map((row) => String(row.story_id)),
    ]),
  }
}

export async function planShadowReadEvent(startsOn) {
  validateShadowReadEventStart(startsOn)
  const { daily, featured, recentIds } = await fetchCandidates(startsOn)
  if (daily.length < DAYS || featured.length === 0) {
    throw new Error('Not enough public stories available to prepare Shadow Read Event')
  }
  const random = makeRng(startsOn)
  const usedIds = new Set()
  const prizeStory = chooseWeighted(featured, usedIds, recentIds, random)
  usedIds.add(String(prizeStory.id))

  const dailyStories = []
  for (let index = 0; index < DAYS; index += 1) {
    const story = chooseWeighted(daily, usedIds, recentIds, random)
    usedIds.add(String(story.id))
    dailyStories.push(story)
  }

  const missions = []
  const milestones = []
  for (let day = 1; day <= DAYS; day += 1) {
    const definitions = [
      ['daily_story', 2, { required_read_percent: 80 }],
      ...getRotatingTasks(startsOn, day),
    ]
    definitions.forEach(([mission_type, target_amount, mission_params], index) => {
      missions.push({
        day_number: day,
        slot: index + 1,
        mission_type,
        story_id: index === 0 ? String(dailyStories[day - 1].id) : null,
        mission_params,
        target_amount,
        max_points: DAILY_MISSION_POINTS[index],
      })
    })
    for (let index = 0; index < 5; index += 1) {
      milestones.push({
        day_number: day,
        tier: index + 1,
        required_points: MILESTONE_POINTS[index],
        coin_reward: MILESTONE_COINS[index],
      })
    }
  }

  return {
    week: {
      starts_on: startsOn,
      featured_story_id: String(prizeStory.id),
      audience_group: 'kh',
      is_enabled: false,
    },
    daily_story_ids: dailyStories.map((story) => String(story.id)),
    missions,
    milestones,
    prize_rules: SHADOW_READ_EVENT_PRIZES,
  }
}
