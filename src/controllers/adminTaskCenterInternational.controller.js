import { supabase } from '../config/supabase.js'
import { invalidateActiveSessionMissionsCache } from '../services/taskCenterMissionCache.service.js'
import {
  rotateTaskCenterInternationalAutoStories,
} from '../services/taskCenterInternationalAuto.service.js'

const AUDIENCE = 'international'
const SETTING_KEY = 'main'
const MAX_MISSIONS = 2
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function text(value, fallback = '', maxLength = 300) {
  return (String(value ?? '').trim() || fallback).slice(0, maxLength)
}

function integer(value, fallback, min, max) {
  if (value === '' || value === null || value === undefined) return fallback
  const result = Number(value)
  if (!Number.isFinite(result)) return fallback
  return Math.max(min, Math.min(max, Math.floor(result)))
}

function publicMission(row) {
  return {
    id: row.id,
    audience: AUDIENCE,
    is_active: Boolean(row.is_active),
    title: row.title || 'Read 2 minutes',
    subtitle: row.subtitle || 'Keep reading to earn rewards.',
    reward_coins: Number(row.reward_coins || 0),
    target_minutes: Number(row.target_minutes || 1),
    story_link: row.story_link || '',
    button_text: row.button_text || 'Go',
    sort_order: Number(row.sort_order || 0),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  }
}

function missionPayload(source = {}, fallbackIndex = 0) {
  return {
    is_active: Boolean(source.is_active),
    title: text(source.title, 'Read 2 minutes', 120),
    subtitle: text(source.subtitle, 'Keep reading to earn rewards.', 240),
    reward_coins: integer(source.reward_coins, 5, 0, 100000),
    target_minutes: integer(source.target_minutes, 2, 1, 300),
    story_link: text(source.story_link, '', 500),
    button_text: text(source.button_text, 'Go', 30),
    sort_order: integer(source.sort_order, fallbackIndex, 0, 999),
    updated_at: new Date().toISOString(),
  }
}

async function getSettings() {
  const { data, error } = await supabase
    .from('task_center_settings')
    .select('setting_key, international_reading_mission_mode, international_auto_last_rotation_date, international_auto_last_rotated_at')
    .eq('setting_key', SETTING_KEY)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new Error('Task Center settings are missing')
  return data
}

async function getRows() {
  const { data, error } = await supabase
    .from('task_center_reading_missions')
    .select('*')
    .eq('audience', AUDIENCE)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(MAX_MISSIONS + 1)

  if (error) throw error
  if ((data || []).length > MAX_MISSIONS) {
    const limitError = new Error('International mission count exceeds the limit of 2')
    limitError.code = 'INTERNATIONAL_MISSION_LIMIT_EXCEEDED'
    throw limitError
  }
  return data || []
}

function responseData(settings, rows) {
  return {
    ok: true,
    audience: AUDIENCE,
    settings: {
      reading_mission_mode: settings.international_reading_mission_mode || 'manual',
      auto_last_rotation_date: settings.international_auto_last_rotation_date || null,
      auto_last_rotated_at: settings.international_auto_last_rotated_at || null,
    },
    reading_missions: rows.map(publicMission),
    missions: rows.map(publicMission),
  }
}

function sendError(res, operation, error) {
  console.error(`TASK CENTER INTERNATIONAL ${operation} ERROR:`, error)
  const knownLimit = error?.code === 'INTERNATIONAL_MISSION_LIMIT_EXCEEDED'
  return res.status(knownLimit ? 409 : 500).json({
    ok: false,
    code: knownLimit ? error.code : 'INTERNATIONAL_MISSION_OPERATION_FAILED',
    message: knownLimit ? error.message : `Failed to ${operation.toLowerCase()} international reading mission`,
  })
}

async function requireManualMode(res) {
  const settings = await getSettings()
  if (settings.international_reading_mission_mode === 'auto') {
    res.status(409).json({
      ok: false,
      code: 'INTERNATIONAL_MANUAL_MODE_REQUIRED',
      message: 'Switch International Reading Mission to Manual mode before changing missions.',
    })
    return false
  }
  return true
}

export async function getAdminInternationalReadingMissions(req, res) {
  try {
    const [settings, rows] = await Promise.all([getSettings(), getRows()])
    return res.status(200).json(responseData(settings, rows))
  } catch (error) {
    return sendError(res, 'GET', error)
  }
}

export async function createAdminInternationalReadingMission(req, res) {
  try {
    if (!(await requireManualMode(res))) return
    const rows = await getRows()
    if (rows.length >= MAX_MISSIONS) {
      return res.status(409).json({
        ok: false,
        code: 'INTERNATIONAL_MISSION_LIMIT_REACHED',
        message: 'Only 2 International Reading Missions are allowed.',
      })
    }

    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('task_center_reading_missions')
      .insert({
        ...missionPayload(req.body, rows.length),
        audience: AUDIENCE,
        created_at: now,
        updated_at: now,
      })
      .select('*')
      .single()

    if (error) throw error
    invalidateActiveSessionMissionsCache()
    return res.status(201).json({
      ok: true,
      audience: AUDIENCE,
      mission: publicMission(data),
      reading_missions: (await getRows()).map(publicMission),
    })
  } catch (error) {
    return sendError(res, 'CREATE', error)
  }
}

export async function updateAdminInternationalReadingMission(req, res) {
  try {
    if (!(await requireManualMode(res))) return
    const missionId = text(req.params.missionId)
    if (!UUID_PATTERN.test(missionId)) {
      return res.status(400).json({ ok: false, code: 'INVALID_MISSION_ID', message: 'Invalid mission id.' })
    }

    const { data: existing, error: readError } = await supabase
      .from('task_center_reading_missions')
      .select('*')
      .eq('id', missionId)
      .eq('audience', AUDIENCE)
      .maybeSingle()

    if (readError) throw readError
    if (!existing) {
      return res.status(404).json({ ok: false, code: 'MISSION_NOT_FOUND', message: 'International mission not found.' })
    }

    const { data, error } = await supabase
      .from('task_center_reading_missions')
      .update(missionPayload({ ...existing, ...(req.body || {}) }, existing.sort_order || 0))
      .eq('id', missionId)
      .eq('audience', AUDIENCE)
      .select('*')
      .maybeSingle()

    if (error) throw error
    if (!data) {
      return res.status(404).json({ ok: false, code: 'MISSION_NOT_FOUND', message: 'International mission not found.' })
    }
    invalidateActiveSessionMissionsCache()
    return res.status(200).json({
      ok: true,
      audience: AUDIENCE,
      mission: publicMission(data),
      reading_missions: (await getRows()).map(publicMission),
    })
  } catch (error) {
    return sendError(res, 'UPDATE', error)
  }
}

export async function deleteAdminInternationalReadingMission(req, res) {
  try {
    if (!(await requireManualMode(res))) return
    const missionId = text(req.params.missionId)
    if (!UUID_PATTERN.test(missionId)) {
      return res.status(400).json({ ok: false, code: 'INVALID_MISSION_ID', message: 'Invalid mission id.' })
    }

    const { data, error } = await supabase
      .from('task_center_reading_missions')
      .delete()
      .eq('id', missionId)
      .eq('audience', AUDIENCE)
      .select('id')
      .maybeSingle()

    if (error) throw error
    if (!data) {
      return res.status(404).json({ ok: false, code: 'MISSION_NOT_FOUND', message: 'International mission not found.' })
    }
    invalidateActiveSessionMissionsCache()
    return res.status(200).json({
      ok: true,
      audience: AUDIENCE,
      reading_missions: (await getRows()).map(publicMission),
    })
  } catch (error) {
    return sendError(res, 'DELETE', error)
  }
}

export async function updateAdminInternationalReadingMissionMode(req, res) {
  const mode = String(req.body?.mode || '').trim().toLowerCase()

  if (!['manual', 'auto'].includes(mode)) {
    return res.status(400).json({
      ok: false,
      code: 'INVALID_INTERNATIONAL_MODE',
    })
  }

  try {
    const previous = await getSettings()
    const previousMode =
      previous.international_reading_mission_mode || 'manual'

    if (mode === 'auto') {
      const missions = await getRows()

      if (missions.length !== MAX_MISSIONS) {
        return res.status(400).json({
          ok: false,
          code: 'INTERNATIONAL_TWO_MISSIONS_REQUIRED',
          message: 'Auto mode requires exactly 2 International missions.',
        })
      }
    }

    const changed = previousMode !== mode

    if (changed) {
      const { error } = await supabase
        .from('task_center_settings')
        .update({
          international_reading_mission_mode: mode,
          updated_at: new Date().toISOString(),
        })
        .eq('setting_key', SETTING_KEY)

      if (error) throw error
    }

    let rotation = null

    try {
      if (mode === 'auto') {
        rotation = await rotateTaskCenterInternationalAutoStories()
      }
    } catch (error) {
      if (changed) {
        const { error: rollbackError } = await supabase
          .from('task_center_settings')
          .update({
            international_reading_mission_mode: previousMode,
            updated_at: new Date().toISOString(),
          })
          .eq('setting_key', SETTING_KEY)
          .eq('international_reading_mission_mode', mode)

        if (rollbackError) {
          console.error('INTERNATIONAL MODE ROLLBACK ERROR:', rollbackError)
        }
      }

      throw error
    }

    const settings = await getSettings()
    const rows = await getRows()

    return res.status(200).json({
      ...responseData(settings, rows),
      mode,
      rotation,
    })
  } catch (error) {
    return sendError(res, 'UPDATE MODE', error)
  }
}

export async function rotateAdminInternationalReadingMissions(req, res) {
  try {
    const result = await rotateTaskCenterInternationalAutoStories({
      force: req.body?.force === true,
    })

    return res.status(200).json({
      ok: true,
      audience: AUDIENCE,
      ...result,
    })
  } catch (error) {
    return sendError(res, 'AUTO ROTATE', error)
  }
}
