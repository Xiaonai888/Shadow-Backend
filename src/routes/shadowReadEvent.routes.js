import express from 'express'
import { rateLimit } from 'express-rate-limit'
import { supabase } from '../config/supabase.js'
import { requireUser } from '../middleware/user.middleware.js'
import { SHADOW_READ_EVENT_PRIZES } from '../services/shadowReadEventPlanner.service.js'

const router = express.Router()
const DAY_MS = 86400000
const FIRST_START = Date.UTC(2026, 10, 2)
const CYCLE_DAYS = 28
const EVENT_DAYS = 7
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const ipLimit = rateLimit({
  windowMs: 60000,
  limit: 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'READ_EVENT_IP_RATE_LIMIT',
    message: 'Too many Read Event requests',
  },
})

const readerLimit = rateLimit({
  windowMs: 60000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user.user_id || req.user.id),
  message: {
    ok: false,
    code: 'READ_EVENT_READER_RATE_LIMIT',
    message: 'Too many Read Event requests',
  },
})

const joinLimit = rateLimit({
  windowMs: 60000,
  limit: 6,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user.user_id || req.user.id),
  message: {
    ok: false,
    code: 'READ_EVENT_JOIN_RATE_LIMIT',
    message: 'Too many Read Event join requests',
  },
})

function khmerDateKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Phnom_Penh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const part = (type) => parts.find((item) => item.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

function utcDate(value) {
  const [year, month, day] = value.split('-').map(Number)
  return Date.UTC(year, month - 1, day)
}

function dateKey(time) {
  return new Date(time).toISOString().slice(0, 10)
}

function currentEventWindow(now = new Date()) {
  const today = khmerDateKey(now)
  const daysSinceStart = Math.round((utcDate(today) - FIRST_START) / DAY_MS)
  if (daysSinceStart < 0) {
    return { active: false, next_start: dateKey(FIRST_START) }
  }

  const cycleDay = daysSinceStart % CYCLE_DAYS
  const currentStart = FIRST_START + (daysSinceStart - cycleDay) * DAY_MS
  if (cycleDay >= EVENT_DAYS) {
    return {
      active: false,
      next_start: dateKey(currentStart + CYCLE_DAYS * DAY_MS),
    }
  }

  return {
    active: true,
    starts_on: dateKey(currentStart),
    ends_on: dateKey(currentStart + (EVENT_DAYS - 1) * DAY_MS),
    day_number: cycleDay + 1,
  }
}

async function isKhmerReader(userId) {
  const { data: classification, error } = await supabase
    .from('shadow_reader_classifications')
    .select('admin_group_override')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error

  if (classification?.admin_group_override === 'kh') return true
  if (classification?.admin_group_override === 'international') return false

  const { data: snapshot, error: snapshotError } = await supabase
    .from('shadow_reader_language_snapshots')
    .select('khmer_stories,international_stories')
    .eq('user_id', userId)
    .maybeSingle()
  if (snapshotError) throw snapshotError

  const khmer = Math.max(0, Number(snapshot?.khmer_stories) || 0)
  const international = Math.max(0, Number(snapshot?.international_stories) || 0)
  return khmer + international >= 3 && khmer >= international
}

function visibleStory(row) {
  if (!row || row.status !== 'published' || row.deleted_at ||
    row.is_adult || row.is_shadow_exclusive ||
    (row.admin_visibility_status && row.admin_visibility_status !== 'active')) {
    return null
  }
  return {
    id: String(row.id),
    title: row.title || '',
    cover_url: row.cover_url || null,
    story_status: row.story_status || '',
    total_episodes: Math.max(0, Number(row.total_episodes) || 0),
    story_url: `/story/${row.id}`,
  }
}

async function readEnabledWeek(startsOn) {
  const { data: week, error } = await supabase
    .from('shadow_read_event_weeks')
    .select('id,starts_on,featured_story_id,audience_group,is_enabled')
    .eq('starts_on', startsOn)
    .maybeSingle()
  if (error) throw error
  return week?.is_enabled === true && week.audience_group === 'kh' ? week : null
}

async function getReadEvent(req, res) {
  res.set('Cache-Control', 'private, no-store')
  const userId = String(req.user?.user_id || req.user?.id || '')
  if (!USER_ID_PATTERN.test(userId)) {
    return res.status(401).json({ ok: false, code: 'READER_ID_INVALID' })
  }

  try {
    if (!(await isKhmerReader(userId))) {
      return res.status(403).json({ ok: false, code: 'KHMER_READER_ONLY' })
    }

    const window = currentEventWindow()
    if (!window.active) return res.json({ ok: true, active: false, next_start: window.next_start })

    const week = await readEnabledWeek(window.starts_on)
    if (!week) {
      return res.json({ ok: true, active: false, scheduled_for: window.starts_on })
    }

    const [missionResult, progressResult, participantResult] = await Promise.all([
      supabase.from('shadow_read_event_missions')
        .select('id,day_number,slot,mission_type,story_id,mission_params,target_amount,max_points')
        .eq('event_id', week.id)
        .eq('day_number', window.day_number)
        .order('slot', { ascending: true })
        .limit(5),
      supabase.rpc('shadow_read_event_reader_progress', {
        p_event_id: week.id,
        p_user_id: userId,
      }),
      supabase.from('shadow_read_event_participants')
        .select('joined_at')
        .eq('event_id', week.id)
        .eq('user_id', userId)
        .maybeSingle(),
    ])
    if (missionResult.error) throw missionResult.error
    if (progressResult.error) throw progressResult.error
    if (participantResult.error) throw participantResult.error

    const progress = Array.isArray(progressResult.data)
      ? progressResult.data[0]
      : progressResult.data
    const missionProgress = progress?.missions
    const milestones = progress?.milestones
    const missions = missionResult.data || []

    if (!progress || progress.ok !== true ||
      String(progress.event_id) !== String(week.id) ||
      Number(progress.day_number) !== window.day_number ||
      typeof progress.joined !== 'boolean' ||
      progress.joined !== Boolean(participantResult.data) ||
      !Array.isArray(missionProgress) || missionProgress.length !== 5 ||
      !Array.isArray(milestones) || milestones.length !== 5 ||
      missions.length !== 5 ||
      missions.some((item, index) => item.slot !== index + 1) ||
      milestones.some((item, index) => Number(item.tier) !== index + 1) ||
      missions[0].mission_type !== 'daily_story' || !missions[0].story_id) {
      throw new Error('Incomplete Read Event daily progress')
    }

    const dailyPoints = Number(progress.daily_points)
    const overallPoints = Number(progress.overall_points)
    if (![dailyPoints, overallPoints].every((value) =>
      Number.isSafeInteger(value) && value >= 0) || overallPoints < dailyPoints) {
      throw new Error('Invalid Read Event score totals')
    }

    const scoreByMissionId = new Map(missionProgress.map((item) => [String(item.mission_id), item]))
    if (scoreByMissionId.size !== 5) throw new Error('Invalid Read Event mission score rows')

    const scoredMissions = missions.map((mission) => {
      const score = scoreByMissionId.get(String(mission.id))
      const earned = Number(score?.earned_points)
      const maximum = Number(mission.max_points)
      if (!score || Number(score.slot) !== mission.slot ||
        String(score.mission_type) !== String(mission.mission_type) ||
        Number(score.max_points) !== maximum ||
        !Number.isSafeInteger(earned) || earned < 0 || earned > maximum ||
        typeof score.completed !== 'boolean' ||
        score.completed !== (earned >= maximum)) {
        throw new Error('Read Event mission score does not match saved plan')
      }
      return {
        ...mission,
        earned_points: earned,
        remaining_points: maximum - earned,
        completed: score.completed,
      }
    })

    const storyIds = [String(week.featured_story_id), String(scoredMissions[0].story_id)]
    if (storyIds[0] === storyIds[1]) throw new Error('Invalid Read Event story selection')
    const { data: stories, error: storiesError } = await supabase
      .from('stories')
      .select('id,title,cover_url,story_status,total_episodes,status,deleted_at,admin_visibility_status,is_adult,is_shadow_exclusive,access_type')
      .in('id', storyIds)
      .limit(2)
    if (storiesError) throw storiesError
    const found = new Map((stories || []).map((row) => [String(row.id), visibleStory(row)]))
    const dailyStory = found.get(storyIds[1])
    const dailySource = (stories || []).find((row) => String(row.id) === storyIds[1])
    const validDailyStory = dailySource &&
      String(dailySource.access_type || 'free').toLowerCase() === 'free'
      ? dailyStory : null

    return res.json({
      ok: true,
      active: true,
      event: {
        id: week.id,
        starts_on: window.starts_on,
        ends_on: window.ends_on,
        day_number: window.day_number,
        audience_group: 'kh',
        featured_story_id: storyIds[0],
        featured_story: found.get(storyIds[0]) || null,
        daily_story: validDailyStory || null,
      },
      participation: {
        joined: progress.joined,
        joined_at: participantResult.data?.joined_at || null,
      },
      missions: scoredMissions,
      milestones,
      progress: {
        day_number: window.day_number,
        daily_points: dailyPoints,
        overall_points: overallPoints,
      },
      prize_rules: SHADOW_READ_EVENT_PRIZES,
    })
  } catch (error) {
    console.error('SHADOW_READ_EVENT_GET_ERROR', error)
    return res.status(503).json({
      ok: false,
      code: 'READ_EVENT_UNAVAILABLE',
      message: 'Read Event is temporarily unavailable',
    })
  }
}

async function joinReadEvent(req, res) {
  res.set('Cache-Control', 'private, no-store')
  const userId = String(req.user?.user_id || req.user?.id || '')
  if (!USER_ID_PATTERN.test(userId)) {
    return res.status(401).json({ ok: false, code: 'READER_ID_INVALID' })
  }

  try {
    if (!(await isKhmerReader(userId))) {
      return res.status(403).json({ ok: false, code: 'KHMER_READER_ONLY' })
    }

    const window = currentEventWindow()
    if (!window.active) {
      return res.status(409).json({ ok: false, code: 'READ_EVENT_NOT_RUNNING' })
    }

    const week = await readEnabledWeek(window.starts_on)
    if (!week) {
      return res.status(409).json({ ok: false, code: 'READ_EVENT_NOT_ENABLED' })
    }

    const [missionCount, milestoneCount, participantResult] = await Promise.all([
      supabase.from('shadow_read_event_missions')
        .select('id', { count: 'exact', head: true })
        .eq('event_id', week.id),
      supabase.from('shadow_read_event_milestones')
        .select('tier', { count: 'exact', head: true })
        .eq('event_id', week.id),
      supabase.from('shadow_read_event_participants')
        .select('joined_at')
        .eq('event_id', week.id)
        .eq('user_id', userId)
        .maybeSingle(),
    ])

    if (missionCount.error) throw missionCount.error
    if (milestoneCount.error) throw milestoneCount.error
    if (participantResult.error) throw participantResult.error

    if (missionCount.count !== 35 || milestoneCount.count !== 35) {
      return res.status(409).json({ ok: false, code: 'READ_EVENT_PLAN_INCOMPLETE' })
    }

    if (participantResult.data) {
      return res.json({
        ok: true,
        joined: true,
        already_joined: true,
        event_id: week.id,
        starts_on: window.starts_on,
      })
    }

    const { error: insertError } = await supabase
      .from('shadow_read_event_participants')
      .insert({
        event_id: week.id,
        user_id: userId,
        reader_group_snapshot: 'kh',
      })

    if (insertError && String(insertError.code) !== '23505') throw insertError

    return res.json({
      ok: true,
      joined: true,
      already_joined: Boolean(insertError),
      event_id: week.id,
      starts_on: window.starts_on,
    })
  } catch (error) {
    console.error('SHADOW_READ_EVENT_JOIN_ERROR', error)
    return res.status(503).json({
      ok: false,
      code: 'READ_EVENT_JOIN_UNAVAILABLE',
      message: 'Unable to join Read Event',
    })
  }
}

router.get('/', ipLimit, requireUser, readerLimit, getReadEvent)
router.post('/join', ipLimit, requireUser, readerLimit, joinLimit, joinReadEvent)

export default router
