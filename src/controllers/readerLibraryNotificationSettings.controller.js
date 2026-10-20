import { supabase } from '../config/supabase.js'

const TABLE = 'reader_library_notification_preferences'
const FIELDS = ['master', 'novel', 'chat_story', 'manga']
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const DEFAULT_PREFERENCES = {
  master: false,
  novel: false,
  chat_story: false,
  manga: false,
}

function getReaderId(req) {
  const id = String(req.user?.user_id || req.user?.id || '').trim()
  return UUID_PATTERN.test(id) ? id : null
}

function toPreferences(row) {
  return Object.fromEntries(FIELDS.map((field) => [field, row?.[field] === true]))
}

function parsePreferences(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  if (Object.keys(body).length !== FIELDS.length) return null
  if (!FIELDS.every((field) => typeof body[field] === 'boolean')) return null
  return Object.fromEntries(FIELDS.map((field) => [field, body[field]]))
}

export async function getReaderLibraryNotificationSettings(req, res) {
  const userId = getReaderId(req)
  if (!userId) {
    return res.status(401).json({ ok: false, message: 'Reader account required' })
  }

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('master,novel,chat_story,manga')
      .eq('user_id', userId)
      .maybeSingle()

    if (error) throw error

    res.setHeader('Cache-Control', 'private, no-store')
    return res.status(200).json({
      ok: true,
      preferences: data ? toPreferences(data) : DEFAULT_PREFERENCES,
    })
  } catch (error) {
    console.error('[LIBRARY_NOTIFICATION_SETTINGS_READ]', error)
    return res.status(500).json({ ok: false, message: 'Failed to load notification settings' })
  }
}

export async function saveReaderLibraryNotificationSettings(req, res) {
  const userId = getReaderId(req)
  if (!userId) {
    return res.status(401).json({ ok: false, message: 'Reader account required' })
  }

  const preferences = parsePreferences(req.body)
  if (!preferences) {
    return res.status(400).json({ ok: false, message: 'Four boolean settings are required' })
  }

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .upsert(
        { user_id: userId, ...preferences, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      )
      .select('master,novel,chat_story,manga')
      .single()

    if (error) throw error

    res.setHeader('Cache-Control', 'private, no-store')
    return res.status(200).json({ ok: true, preferences: toPreferences(data) })
  } catch (error) {
    console.error('[LIBRARY_NOTIFICATION_SETTINGS_SAVE]', error)
    return res.status(500).json({ ok: false, message: 'Failed to save notification settings' })
  }
}
