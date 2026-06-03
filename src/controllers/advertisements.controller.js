import { supabase } from '../config/supabase.js'

const allowedPlacements = ['splash', 'opening', 'freeUnlock']
const allowedFrequencies = ['once_per_session', 'once_per_day', 'every_visit', 'every_unlock']

function normalizeText(value) {
  return String(value || '').trim()
}

function normalizeBoolean(value) {
  return value === true || value === 'true' || value === 1 || value === '1'
}

function normalizeNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback
}

function publicAd(item) {
  return {
    placement: item.placement,
    enabled: Boolean(item.enabled),
    image_url: item.image_url || '',
    link_url: item.link_url || '',
    duration_seconds: Number(item.duration_seconds || 0),
    close_after_seconds: Number(item.close_after_seconds || 0),
    frequency: item.frequency || 'once_per_session',
    updated_at: item.updated_at,
  }
}

export async function getPublicAdvertisement(req, res) {
  try {
    const placement = normalizeText(req.query.placement)

    if (!allowedPlacements.includes(placement)) {
      return res.status(400).json({ ok: false, message: 'Invalid advertisement placement' })
    }

    const { data, error } = await supabase
      .from('shadow_advertisements')
      .select('placement, enabled, image_url, link_url, duration_seconds, close_after_seconds, frequency, updated_at')
      .eq('placement', placement)
      .eq('enabled', true)
      .maybeSingle()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      advertisement: data ? publicAd(data) : null,
    })
  } catch (error) {
    console.error('GET PUBLIC ADVERTISEMENT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load advertisement',
      error: error.message,
    })
  }
}

export async function getAdminAdvertisements(req, res) {
  try {
    const { data, error } = await supabase
      .from('shadow_advertisements')
      .select('placement, enabled, image_url, link_url, duration_seconds, close_after_seconds, frequency, created_at, updated_at')
      .order('placement', { ascending: true })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      advertisements: data || [],
    })
  } catch (error) {
    console.error('GET ADMIN ADVERTISEMENTS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load advertisements',
      error: error.message,
    })
  }
}

export async function updateAdminAdvertisement(req, res) {
  try {
    const placement = normalizeText(req.params.placement)

    if (!allowedPlacements.includes(placement)) {
      return res.status(400).json({ ok: false, message: 'Invalid advertisement placement' })
    }

    const frequency = normalizeText(req.body.frequency) || 'once_per_session'

    if (!allowedFrequencies.includes(frequency)) {
      return res.status(400).json({ ok: false, message: 'Invalid advertisement frequency' })
    }

    const payload = {
      placement,
      enabled: normalizeBoolean(req.body.enabled),
      image_url: normalizeText(req.body.image_url),
      link_url: normalizeText(req.body.link_url),
      duration_seconds: normalizeNumber(req.body.duration_seconds, 5),
      close_after_seconds: normalizeNumber(req.body.close_after_seconds, 3),
      frequency,
      updated_at: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from('shadow_advertisements')
      .upsert(payload, { onConflict: 'placement' })
      .select('placement, enabled, image_url, link_url, duration_seconds, close_after_seconds, frequency, created_at, updated_at')
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      advertisement: data,
    })
  } catch (error) {
    console.error('UPDATE ADMIN ADVERTISEMENT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to save advertisement',
      error: error.message,
    })
  }
}
