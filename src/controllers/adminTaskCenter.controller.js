import { supabase } from '../config/supabase.js'
import { uploadFileToR2 } from '../services/r2Storage.service.js'

const SETTING_KEY = 'main'

function publicSettings(row) {
  return {
    cover_url: row?.cover_url || '',
    cover_updated_at: row?.cover_updated_at || null,
    updated_at: row?.updated_at || null,
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

export async function getAdminTaskCenterSettings(req, res) {
  try {
    const row = await getSettingsRow()

    return res.status(200).json({
      ok: true,
      settings: publicSettings(row),
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

export async function updateAdminTaskCenterCover(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, message: 'Cover image is required' })
    }

    if (!isAllowedCover(req.file)) {
      return res.status(400).json({ ok: false, message: 'Only WebP, JPG, or PNG cover images are allowed' })
    }

    const coverUrl = await uploadFileToR2(req.file, 'task-center/covers')
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
