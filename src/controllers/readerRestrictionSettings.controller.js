import { supabase } from '../config/supabase.js'

const PREFERENCE_KEYS = new Set([
  'hide_comments',
  'filter_messages',
  'hide_activity_status',
  'mute_mentions',
])

const DEFAULT_SETTINGS = Object.freeze({
  hide_comments: false,
  filter_messages: false,
  hide_activity_status: false,
  mute_mentions: false,
})

function userId(req) {
  return String(req.user?.user_id || req.user?.id || '').trim()
}

function respondError(res, error, action) {
  console.error(`READER_RESTRICTION_SETTINGS_${action}_ERROR:`, error)
  res.set('Cache-Control', 'private, no-store')
  return res.status(503).json({ ok: false, message: 'Restriction settings are temporarily unavailable.' })
}

function formattedSettings(data) {
  return Object.fromEntries(
    Object.keys(DEFAULT_SETTINGS).map((key) => [key, data?.[key] === true]),
  )
}

export async function getMyReaderRestrictionSettings(req, res) {
  const owner = userId(req)
  if (!owner) return res.status(401).json({ ok: false, message: 'Please sign in again.' })

  try {
    const { data, error } = await supabase
      .from('reader_restriction_settings')
      .select('hide_comments,filter_messages,hide_activity_status,mute_mentions')
      .eq('user_id', owner)
      .maybeSingle()
    if (error) throw error
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({ ok: true, settings: formattedSettings(data) })
  } catch (error) {
    return respondError(res, error, 'GET')
  }
}

export async function updateMyReaderRestrictionSetting(req, res) {
  const owner = userId(req)
  if (!owner) return res.status(401).json({ ok: false, message: 'Please sign in again.' })

  const key = req.body?.key
  const enabled = req.body?.enabled
  if (!PREFERENCE_KEYS.has(key) || typeof enabled !== 'boolean') {
    return res.status(400).json({ ok: false, message: 'Invalid restriction setting.' })
  }

  try {
    const { data, error } = await supabase
      .from('reader_restriction_settings')
      .upsert({ user_id: owner, [key]: enabled, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
      .select('hide_comments,filter_messages,hide_activity_status,mute_mentions')
      .single()
    if (error) throw error
    res.set('Cache-Control', 'private, no-store')
    return res.status(200).json({ ok: true, settings: formattedSettings(data) })
  } catch (error) {
    return respondError(res, error, 'UPDATE')
  }
}
