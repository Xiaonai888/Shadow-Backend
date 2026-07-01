import { supabase } from '../config/supabase.js'
import { uploadImageToR2AsWebP } from '../services/r2Storage.service.js'


const SETTING_KEY = 'main'

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

export async function getPublicTaskCenterSettings(req, res) {
  try {
    const row = await getSettingsRow()

    return res.status(200).json({
      ok: true,
      settings: publicSettings(row),
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

    const payload = buildReadingMissionPayload(req.body, 0)

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
      message: 'Reading mission updated',
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

export async function deleteAdminReadingMission(req, res) {
  try {
    return res.status(200).json({
      ok: true,
      message: 'Reading missions are not configured yet',
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
