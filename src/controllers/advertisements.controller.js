import { supabase } from '../config/supabase.js'
import { uploadFileToR2 } from '../services/r2Storage.service.js'
const allowedPlacements = ['splash', 'opening', 'freeUnlock', 'me']
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

function getAdminActor(req) {
  return req.admin?.username || req.admin?.email || req.user?.username || req.user?.email || 'Admin'
}

function getAdvertisementAction(payload) {
  if (payload.enabled) return 'UPDATE'
  return 'DISABLE'
}

function getAdvertisementDetails(payload) {
  const placementLabel = payload.placement === 'freeUnlock'
    ? 'Free Unlock & Read Ad'
    : payload.placement === 'opening'
      ? 'Opening Ad'
      : 'Splash Logo Ad'

  return `${placementLabel} updated. Status: ${payload.enabled ? 'Enabled' : 'Disabled'}. Frequency: ${payload.frequency || 'once_per_session'}.`
}

async function createAdvertisementLog(req, payload) {
  await supabase.from('shadow_advertisement_logs').insert({
    placement: payload.placement,
    action: getAdvertisementAction(payload),
    details: getAdvertisementDetails(payload),
    actor: getAdminActor(req),
    image_url: payload.image_url || '',
    frequency: payload.frequency || '',
    enabled: Boolean(payload.enabled),
  })
}

async function uploadAdvertisementImage(file, placement) {
  return uploadFileToR2(file, `advertisements/${placement}`)
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

export async function getAdminAdvertisementLogs(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page || 1))
    const limit = Math.min(50, Math.max(1, Number(req.query.limit || 20)))
    const placement = normalizeText(req.query.placement)
    const from = (page - 1) * limit
    const to = from + limit - 1

    let query = supabase
      .from('shadow_advertisement_logs')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to)

    if (allowedPlacements.includes(placement)) {
      query = query.eq('placement', placement)
    }

    const { data, error, count } = await query

    if (error) throw error

    const total = Number(count || 0)
    const totalPages = Math.max(1, Math.ceil(total / limit))

    return res.status(200).json({
      ok: true,
      logs: data || [],
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
    })
  } catch (error) {
    console.error('GET ADMIN ADVERTISEMENT LOGS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load advertisement logs',
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

    const uploadedImageUrl = req.file ? await uploadAdvertisementImage(req.file, placement) : ''
    const bodyImageUrl = normalizeText(req.body.image_url)

    const payload = {
      placement,
      enabled: normalizeBoolean(req.body.enabled),
      image_url: uploadedImageUrl || bodyImageUrl,
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

await createAdvertisementLog(req, data).catch((logError) => {
  console.error('CREATE ADVERTISEMENT LOG ERROR:', logError)
})

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
