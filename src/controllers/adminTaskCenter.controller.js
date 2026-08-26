import crypto from 'crypto'
import { supabase } from '../config/supabase.js'
import { uploadImageToR2AsWebP } from '../services/r2Storage.service.js'
import { rotateTaskCenterAutoStories } from '../services/taskCenterAuto.service.js'

const SETTING_KEY = 'main'


function buildTaskCenterVersion(settingsRow, missionRows = []) {
  const payload = {
    cover_url: settingsRow?.cover_url || '',
    cover_updated_at: settingsRow?.cover_updated_at || null,
    settings_updated_at: settingsRow?.updated_at || null,
    reading_task_updated_at: settingsRow?.reading_task_updated_at || null,
    missions: (missionRows || []).map((row) => ({
      id: row.id,
      is_active: Boolean(row.is_active),
      title: row.title || '',
      subtitle: row.subtitle || '',
      reward_coins: Number(row.reward_coins || 0),
      target_minutes: Number(row.target_minutes || 0),
      story_link: row.story_link || '',
      button_text: row.button_text || '',
      sort_order: Number(row.sort_order || 0),
      created_at: row.created_at || null,
      updated_at: row.updated_at || null,
    })),
  }

  return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex')
}

function publicSettings(row) {
  return {
    cover_url: row?.cover_url || '',
    cover_updated_at: row?.cover_updated_at || null,
    updated_at: row?.updated_at || null,
    reading_task: {
      is_active: Boolean(row?.reading_task_active),
      title: row?.reading_task_title || 'Read 30 minutes',
      subtitle: row?.reading_task_subtitle || 'Keep reading longer to earn more coins.',
      reward_coins: Number(row?.reading_task_reward_coins || 60),
      target_minutes: Number(row?.reading_task_target_minutes || 30),
      story_link: row?.reading_task_story_link || '',
      button_text: row?.reading_task_button_text || 'Go',
      updated_at: row?.reading_task_updated_at || null,
    },
  }
}

async function getSettingsRow() {
  const { data, error } = await supabase
    .from('task_center_settings')
    .select('*')
    .eq('setting_key', SETTING_KEY)
    .maybeSingle()

  if (error) throw error

  if (data) return data

  const { data: created, error: createError } = await supabase
    .from('task_center_settings')
    .insert({ setting_key: SETTING_KEY, cover_url: '' })
    .select('*')
    .single()

  if (createError) throw createError

  return created
}

function isAllowedCover(file) {
  return ['image/webp', 'image/jpeg', 'image/png'].includes(file?.mimetype)
}


export async function getPublicTaskCenterVersion(req, res) {
  try {
    const [settingsResult, missionsResult] = await Promise.all([
      supabase
        .from('task_center_settings')
        .select('cover_url, cover_updated_at, updated_at, reading_task_updated_at')
        .eq('setting_key', SETTING_KEY)
        .maybeSingle(),

      supabase
        .from('task_center_reading_missions')
        .select('id, is_active, title, subtitle, reward_coins, target_minutes, story_link, button_text, sort_order, created_at, updated_at')
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: false })
        .limit(2),
    ])

    if (settingsResult.error) throw settingsResult.error
    if (missionsResult.error) throw missionsResult.error

    const version = buildTaskCenterVersion(settingsResult.data || null, missionsResult.data || [])

    return res.status(200).json({
      ok: true,
      version,
      mission_count: Array.isArray(missionsResult.data) ? missionsResult.data.length : 0,
    })
  } catch (error) {
    console.error('GET PUBLIC TASK CENTER VERSION ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load task center version',
      error: error.message,
    })
  }
}


export async function getPublicTaskCenterSettings(req, res) {
  try {
    const row = await getSettingsRow()
    const readingMissions = await getPublicReadingMissions()

    return res.status(200).json({
      ok: true,
      settings: {
        ...publicSettings(row),
        reading_missions: readingMissions,
      },
      reading_missions: readingMissions,
      missions: readingMissions,
    })
  } catch (error) {
    console.error('GET PUBLIC TASK CENTER SETTINGS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load task center settings',
      error: error.message,
    })
  }
}

function cleanText(value, fallback = '', maxLength = 300) {
  const text = String(value ?? '').trim()

  return (text || fallback).slice(0, maxLength)
}

function cleanNumber(value, fallback = 0, min = 0, max = 999999) {
  const number = Number(value)

  if (!Number.isFinite(number)) return fallback

  return Math.min(max, Math.max(min, Math.floor(number)))
}

function cleanMissionId(value) {
  const text = String(value || '').trim()

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)
    ? text
    : null
}

function publicReadingMission(row) {
  return {
    id: row.id,
    is_active: Boolean(row.is_active),
    title: row.title || 'Read 2 minutes',
    subtitle: row.subtitle || 'Keep reading longer to earn more coins.',
    reward_coins: Number(row.reward_coins || 0),
    target_minutes: Number(row.target_minutes || 1),
    story_link: row.story_link || '',
    button_text: row.button_text || 'Go',
    sort_order: Number(row.sort_order || 0),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  }
}

function buildReadingMissionPayload(body = {}, index = 0) {
  return {
    is_active: Boolean(body.is_active),
    title: cleanText(body.title, 'Read 2 minutes', 120),
    subtitle: cleanText(body.subtitle, 'Keep reading longer to earn more coins.', 240),
    reward_coins: cleanNumber(body.reward_coins, 5, 0, 100000),
    target_minutes: cleanNumber(body.target_minutes, 2, 1, 300),
    story_link: cleanText(body.story_link, '', 500),
    button_text: cleanText(body.button_text, 'Go', 30),
    sort_order: cleanNumber(body.sort_order, index, 0, 999),
    updated_at: new Date().toISOString(),
  }
}

async function getReadingMissionRows() {
  const { data, error } = await supabase
    .from('task_center_reading_missions')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(2)

  if (error) throw error

  return data || []
}

async function getPublicReadingMissions() {
  const rows = await getReadingMissionRows()

  return rows.map(publicReadingMission)
}

export async function getAdminTaskCenterSettings(req, res) {
  try {
    const row = await getSettingsRow()
    const readingMissions = await getPublicReadingMissions()

    return res.status(200).json({
      ok: true,
      settings: {
        ...publicSettings(row),
        reading_mission_mode: row?.reading_mission_mode || 'manual',
        auto_last_rotation_date: row?.auto_last_rotation_date || null,
        auto_last_rotated_at: row?.auto_last_rotated_at || null,
        reading_missions: readingMissions,
      },
      reading_missions: readingMissions,
      missions: readingMissions,
    })
  } catch (error) {
    console.error('GET ADMIN TASK CENTER SETTINGS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load task center settings',
      error: error.message,
    })
  }
}

export async function updateAdminReadingTask(req, res) {
  try {
    await getSettingsRow()

    const now = new Date().toISOString()

    const payload = {
      reading_task_active: Boolean(req.body?.is_active),
      reading_task_title: cleanText(req.body?.title, 'Read 30 minutes', 120),
      reading_task_subtitle: cleanText(req.body?.subtitle, 'Keep reading longer to earn more coins.', 240),
      reading_task_reward_coins: cleanNumber(req.body?.reward_coins, 60, 0, 100000),
      reading_task_target_minutes: cleanNumber(req.body?.target_minutes, 30, 1, 300),
      reading_task_story_link: cleanText(req.body?.story_link, '', 500),
      reading_task_button_text: cleanText(req.body?.button_text, 'Go', 30),
      reading_task_updated_at: now,
      updated_at: now,
    }

    const { data, error } = await supabase
      .from('task_center_settings')
      .update(payload)
      .eq('setting_key', SETTING_KEY)
      .select('*')
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      settings: publicSettings(data),
    })
  } catch (error) {
    console.error('UPDATE ADMIN READING TASK ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to update reading task',
      error: error.message,
    })
  }
}

export async function updateAdminTaskCenterCover(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, message: 'Cover image is required' })
    }

    if (!isAllowedCover(req.file)) {
      return res.status(400).json({ ok: false, message: 'Only WebP, JPG, or PNG cover images are allowed' })
    }

    const coverUrl = await uploadImageToR2AsWebP(req.file, 'task-center/covers', { width: 1600, quality: 82 })
    const now = new Date().toISOString()

    const { data, error } = await supabase
      .from('task_center_settings')
      .upsert(
        {
          setting_key: SETTING_KEY,
          cover_url: coverUrl,
          cover_updated_at: now,
          updated_at: now,
        },
        { onConflict: 'setting_key' }
      )
      .select('*')
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      settings: publicSettings(data),
    })
  } catch (error) {
    console.error('UPDATE ADMIN TASK CENTER COVER ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to update task center cover',
      error: error.message,
    })
  }
}

export async function getAdminReadingMissions(req, res) {
  try {
    const readingMissions = await getPublicReadingMissions()

    return res.status(200).json({
      ok: true,
      reading_missions: readingMissions,
      missions: readingMissions,
    })
  } catch (error) {
    console.error('GET ADMIN READING MISSIONS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load reading missions',
      error: error.message,
    })
  }
}

export async function createAdminReadingMission(req, res) {
  try {
    const settingsRow = await getSettingsRow()
if (String(settingsRow?.reading_mission_mode || 'manual') === 'auto') {
  return res.status(409).json({
    ok: false,
    message: 'Switch to Manual mode before adding missions',
  })
}
    const existingRows = await getReadingMissionRows()

    if (existingRows.length >= 2) {
      return res.status(400).json({
        ok: false,
        message: 'Only 2 reading missions are allowed',
      })
    }

    const payload = buildReadingMissionPayload(req.body, existingRows.length)
    const now = new Date().toISOString()

    const { data, error } = await supabase
      .from('task_center_reading_missions')
      .insert({
        ...payload,
        created_at: now,
        updated_at: now,
      })
      .select('*')
      .single()

    if (error) throw error

    const readingMissions = await getPublicReadingMissions()

    return res.status(200).json({
      ok: true,
      mission: publicReadingMission(data),
      reading_missions: readingMissions,
      missions: readingMissions,
      message: 'Reading mission created',
    })
  } catch (error) {
    console.error('CREATE ADMIN READING MISSION ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to create reading mission',
      error: error.message,
    })
  }
}

export async function updateAdminReadingMission(req, res) {
  try {
    const missionId = cleanMissionId(req.params.missionId)

    if (!missionId) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid reading mission id',
      })
    }

    const settingsRow = await getSettingsRow()
    const requestedPayload = buildReadingMissionPayload(req.body, 0)
    let payload = requestedPayload

    if (String(settingsRow?.reading_mission_mode || 'manual') === 'auto') {
      const { data: existingMission, error: existingError } = await supabase
        .from('task_center_reading_missions')
        .select('*')
        .eq('id', missionId)
        .single()

      if (existingError) throw existingError

      payload = {
        is_active: Boolean(existingMission.is_active),
        title: `Read ${requestedPayload.target_minutes} minutes`,
        subtitle: existingMission.subtitle,
        reward_coins: requestedPayload.reward_coins,
        target_minutes: requestedPayload.target_minutes,
        story_link: existingMission.story_link,
        button_text: existingMission.button_text,
        sort_order: Number(existingMission.sort_order || 0),
        updated_at: new Date().toISOString(),
      }
    }

    const { data, error } = await supabase
      .from('task_center_reading_missions')
      .update(payload)
      .eq('id', missionId)
      .select('*')
      .single()

    if (error) throw error

    const readingMissions = await getPublicReadingMissions()

    return res.status(200).json({
      ok: true,
      mission: publicReadingMission(data),
      reading_missions: readingMissions,
      missions: readingMissions,
      message:
        String(settingsRow?.reading_mission_mode || 'manual') === 'auto'
          ? 'Auto mission reward and minutes updated'
          : 'Reading mission updated',
    })
  } catch (error) {
    console.error('UPDATE ADMIN READING MISSION ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to update reading mission',
      error: error.message,
    })
  }
}


export async function deleteAdminReadingMission(req, res) {
  try {
    const settingsRow = await getSettingsRow()
if (String(settingsRow?.reading_mission_mode || 'manual') === 'auto') {
  return res.status(409).json({
    ok: false,
    message: 'Switch to Manual mode before deleting missions',
  })
}
    const missionId = cleanMissionId(req.params.missionId)

    if (!missionId) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid reading mission id',
      })
    }

    const { error } = await supabase
      .from('task_center_reading_missions')
      .delete()
      .eq('id', missionId)

    if (error) throw error

    const readingMissions = await getPublicReadingMissions()

    return res.status(200).json({
      ok: true,
      reading_missions: readingMissions,
      missions: readingMissions,
      message: 'Reading mission deleted',
    })
  } catch (error) {
    console.error('DELETE ADMIN READING MISSION ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to delete reading mission',
      error: error.message,
    })
  }
}

function hasValidTaskCenterAutoSecret(req) {
  const expected = String(process.env.TASK_CENTER_AUTO_SECRET || '')
  const supplied = String(req.get('x-task-center-auto-secret') || '')

  if (!expected || !supplied) return false

  const expectedBuffer = Buffer.from(expected)
  const suppliedBuffer = Buffer.from(supplied)

  return (
    expectedBuffer.length === suppliedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)
  )
}

export async function updateAdminReadingMissionMode(req, res) {
  try {
    const mode = String(req.body?.mode || '').trim().toLowerCase()

    if (!['manual', 'auto'].includes(mode)) {
      return res.status(400).json({
        ok: false,
        message: 'Reading mission mode must be manual or auto',
      })
    }

    await getSettingsRow()

    if (mode === 'auto') {
      const missions = await getReadingMissionRows()

      if (missions.length !== 2) {
        return res.status(400).json({
          ok: false,
          message: 'Auto mode requires exactly 2 reading missions',
        })
      }
    }

    const now = new Date().toISOString()
    const { error } = await supabase
      .from('task_center_settings')
      .update({
        reading_mission_mode: mode,
        updated_at: now,
      })
      .eq('setting_key', SETTING_KEY)

    if (error) throw error

    const rotation = mode === 'auto'
      ? await rotateTaskCenterAutoStories()
      : null

    const settings = await getSettingsRow()

    return res.status(200).json({
      ok: true,
      mode,
      settings: {
        ...publicSettings(settings),
        reading_mission_mode: settings.reading_mission_mode || 'manual',
        auto_last_rotation_date: settings.auto_last_rotation_date || null,
        auto_last_rotated_at: settings.auto_last_rotated_at || null,
      },
      rotation,
      message: mode === 'auto' ? 'Auto reading mission enabled' : 'Manual reading mission enabled',
    })
  } catch (error) {
    console.error('UPDATE ADMIN READING MISSION MODE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to update reading mission mode',
      error: error.message,
    })
  }
}

export async function rotateAdminTaskCenterAutoStories(req, res) {
  try {
    const result = await rotateTaskCenterAutoStories({
      force: Boolean(req.body?.force),
    })

    return res.status(200).json({
      ok: true,
      ...result,
    })
  } catch (error) {
    console.error('ADMIN TASK CENTER AUTO ROTATION ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to rotate Task Center auto stories',
      error: error.message,
    })
  }
}

export async function runTaskCenterAutoRotation(req, res) {
  if (!hasValidTaskCenterAutoSecret(req)) {
    return res.status(401).json({
      ok: false,
      message: 'Unauthorized',
    })
  }

  try {
    const result = await rotateTaskCenterAutoStories()

    return res.status(200).json({
      ok: true,
      ...result,
    })
  } catch (error) {
    console.error('TASK CENTER AUTO ROTATION RUN ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to run Task Center auto rotation',
      error: error.message,
    })
  }
}


function getTaskCenterActivityDateKey(date = new Date()) {
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

function shiftTaskCenterActivityDate(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function cleanTaskCenterActivityDate(value) {
  const text = String(value || '').trim()

  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return getTaskCenterActivityDateKey()
  }

  const date = new Date(`${text}T00:00:00.000Z`)

  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    return getTaskCenterActivityDateKey()
  }

  return text
}

function emptyTaskCenterActivitySummary(activityDate) {
  return {
    activity_date: activityDate,
    active_readers: 0,
    manual_claims: 0,
    premium_auto_claims: 0,
    mission_starters: 0,
    all_completed_users: 0,
    completion_rate: 0,
    updated_at: null,
  }
}

async function runTaskCenterActivityMaintenanceSafe() {
  const { error } = await supabase.rpc('task_center_run_activity_retention')

  if (error) {
    console.error('TASK CENTER ACTIVITY RETENTION ERROR:', error)
  }
}

async function getTaskCenterActivitySummary(activityDate) {
  const todayKey = getTaskCenterActivityDateKey()
  const fullDetailCutoff = shiftTaskCenterActivityDate(todayKey, -14)

  let { data: summary, error } = await supabase
    .from('task_center_daily_summaries')
    .select('*')
    .eq('activity_date', activityDate)
    .maybeSingle()

  if (error) throw error

  const canRefreshFromFullDetail = activityDate >= fullDetailCutoff && activityDate <= todayKey
  const updatedAtMs = summary?.updated_at ? new Date(summary.updated_at).getTime() : 0
  const summaryIsStale =
    !summary ||
    !Number.isFinite(updatedAtMs) ||
    Date.now() - updatedAtMs >= 6 * 60 * 60 * 1000

  if (canRefreshFromFullDetail && summaryIsStale) {
    const { error: refreshError } = await supabase.rpc(
      'task_center_refresh_daily_summary',
      { p_activity_date: activityDate }
    )

    if (refreshError) throw refreshError

    const refreshed = await supabase
      .from('task_center_daily_summaries')
      .select('*')
      .eq('activity_date', activityDate)
      .maybeSingle()

    if (refreshed.error) throw refreshed.error
    summary = refreshed.data || null
  }

  return summary || emptyTaskCenterActivitySummary(activityDate)
}

export async function getAdminReaderActivity(req, res) {
  try {
    const activityDate = cleanTaskCenterActivityDate(req.query.date)
    const todayKey = getTaskCenterActivityDateKey()
    const oldestUserDetailDate = shiftTaskCenterActivityDate(todayKey, -365)
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1)
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 50))
    const filter = String(req.query.filter || 'all').trim().toLowerCase()
    const allowedFilters = new Set([
      'all',
      'manual',
      'premium',
      'completed',
      'incomplete',
    ])

    if (!allowedFilters.has(filter)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid activity filter',
      })
    }

    if (activityDate > todayKey) {
      return res.status(400).json({
        ok: false,
        message: 'Activity date cannot be in the future',
      })
    }

    await runTaskCenterActivityMaintenanceSafe()

    if (req.query.refresh === '1') {
  await supabase.rpc('task_center_refresh_daily_summary', { p_activity_date: activityDate })
}

const summary = await getTaskCenterActivitySummary(activityDate)
    const detailAvailable = activityDate >= oldestUserDetailDate

    if (!detailAvailable) {
      return res.status(200).json({
        ok: true,
        activity_date: activityDate,
        summary,
        readers: [],
        pagination: {
          page: 1,
          limit,
          total: 0,
          total_pages: 0,
        },
        retention: {
          full_detail_days: 14,
          user_summary_days: 365,
          platform_summary_days: 1095,
          detail_available: false,
        },
      })
    }

    const from = (page - 1) * limit
    const to = from + limit - 1

    let snapshotsQuery = supabase
      .from('task_center_reader_daily_snapshots')
      .select(
        'activity_date,user_id,checkin_claimed,checkin_source_key,streak_day,reading_seconds,reading_target_seconds,reading_percent,mission_progress,missions_completed,missions_total,all_completed,last_activity_at,created_at,updated_at',
        { count: 'exact' }
      )
      .eq('activity_date', activityDate)

    if (filter === 'manual') {
      snapshotsQuery = snapshotsQuery.eq('checkin_source_key', 'daily_bonus')
    } else if (filter === 'premium') {
      snapshotsQuery = snapshotsQuery.eq('checkin_source_key', 'premium_auto_claim')
    } else if (filter === 'completed') {
      snapshotsQuery = snapshotsQuery.eq('all_completed', true)
    } else if (filter === 'incomplete') {
      snapshotsQuery = snapshotsQuery.eq('all_completed', false)
    }

    const {
      data: snapshotRows,
      error: snapshotError,
      count,
    } = await snapshotsQuery
      .order('last_activity_at', { ascending: false, nullsFirst: false })
      .range(from, to)

    if (snapshotError) throw snapshotError

    const rows = snapshotRows || []
    const userIds = [...new Set(rows.map((row) => row.user_id).filter(Boolean))]
    let users = []

    if (userIds.length > 0) {
      const { data: userRows, error: userError } = await supabase
        .from('users')
        .select('id,name,username,email,role')
        .in('id', userIds)

      if (userError) throw userError
      users = userRows || []
    }

    const userMap = new Map(users.map((user) => [user.id, user]))

    const readers = rows.map((row) => {
      const user = userMap.get(row.user_id) || null
      const missionProgress = Array.isArray(row.mission_progress)
        ? row.mission_progress
        : []

      return {
        activity_date: row.activity_date,
        user_id: row.user_id,
        user: user
          ? {
              id: user.id,
              name: user.name || '',
              username: user.username || '',
              email: user.email || '',
              role: user.role || '',
            }
          : null,
        checkin_claimed: Boolean(row.checkin_claimed),
        claim_type: row.checkin_source_key || null,
        premium_auto_claim: row.checkin_source_key === 'premium_auto_claim',
        streak_day: Number(row.streak_day || 0),
        reading_seconds: Number(row.reading_seconds || 0),
        reading_minutes: Math.floor(Number(row.reading_seconds || 0) / 60),
        reading_target_seconds: Number(row.reading_target_seconds || 1800),
        reading_percent: Number(row.reading_percent || 0),
        mission_progress: missionProgress,
        missions_completed: Number(row.missions_completed || 0),
        missions_total: Number(row.missions_total || 0),
        all_completed: Boolean(row.all_completed),
        last_activity_at: row.last_activity_at || null,
        updated_at: row.updated_at || null,
      }
    })

    return res.status(200).json({
      ok: true,
      activity_date: activityDate,
      filter,
      summary,
      readers,
      pagination: {
        page,
        limit,
        total: Number(count || 0),
        total_pages: Math.ceil(Number(count || 0) / limit),
      },
      retention: {
        full_detail_days: 14,
        user_summary_days: 365,
        platform_summary_days: 1095,
        detail_available: true,
      },
    })
  } catch (error) {
    console.error('GET ADMIN TASK CENTER READER ACTIVITY ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load reader activity',
      error: error.message,
    })
  }
}
