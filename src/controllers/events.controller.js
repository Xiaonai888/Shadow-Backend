import { supabase } from '../config/supabase.js'
import {
  getActivePublicEvents,
  invalidatePublicEventsCache,
} from '../services/publicEventsCache.service.js'

function cleanText(value) {
  return String(value ?? '').trim()
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    cleanText(value)
  )
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value

  const normalized = cleanText(value).toLowerCase()

  if (normalized === 'true' || normalized === '1') return true
  if (normalized === 'false' || normalized === '0') return false

  return fallback
}

function normalizeSortOrder(value, fallback = 0) {
  const number = Number(value)

  if (!Number.isInteger(number)) return fallback

  return number
}

function normalizeTimestamp(value, allowEmpty = false) {
  if (value === null || value === undefined || value === '') {
    return allowEmpty ? null : ''
  }

  const text = cleanText(value)
  const time = new Date(text).getTime()

  if (!Number.isFinite(time)) return ''

  return new Date(time).toISOString()
}

function getEventStatus(row) {
  const now = Date.now()
  const start = row.starts_at ? new Date(row.starts_at).getTime() : null
  const end = row.ends_at ? new Date(row.ends_at).getTime() : null

  if (!row.is_published) return 'draft'
  if (end !== null && Number.isFinite(end) && now >= end) return 'ended'
  if (start !== null && Number.isFinite(start) && now < start) return 'scheduled'

  return 'live'
}

function serializeEvent(row) {
  return {
    id: row.id,
    title: row.title || '',
    description: row.description || '',
    badge_text: row.badge_text || '',
    image_url: row.image_url || '',
    image_storage_key: row.image_storage_key || '',
    banner_url: row.banner_url || '',
    banner_storage_key: row.banner_storage_key || '',
    button_text: row.button_text || '',
    button_url: row.button_url || '',
    starts_at: row.starts_at || null,
    ends_at: row.ends_at,
    sort_order: Number(row.sort_order || 0),
    is_published: Boolean(row.is_published),
    status: getEventStatus(row),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export async function listAdminEvents(req, res) {
  try {
    const { data, error } = await supabase
      .from('shadow_events')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      events: (data || []).map(serializeEvent),
    })
  } catch (error) {
    console.error('ADMIN LIST EVENTS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load events',
      error: error.message,
    })
  }
}

export async function createEvent(req, res) {
  try {
    const title = cleanText(req.body?.title)
    const description = cleanText(req.body?.description)
    const badgeText = cleanText(req.body?.badge_text)
    const imageUrl = cleanText(req.body?.image_url)
    const imageStorageKey = cleanText(req.body?.image_storage_key)
    const bannerUrl = cleanText(req.body?.banner_url)
    const bannerStorageKey = cleanText(req.body?.banner_storage_key)
    const buttonText = cleanText(req.body?.button_text)
    const buttonUrl = cleanText(req.body?.button_url)
    const startsAt = normalizeTimestamp(req.body?.starts_at, true)
    const endsAt = normalizeTimestamp(req.body?.ends_at)
    const sortOrder = normalizeSortOrder(req.body?.sort_order, 0)
    const isPublished = normalizeBoolean(req.body?.is_published, false)

    if (!title) {
  return res.status(400).json({
    ok: false,
    message: 'Title is required',
  })
}

    if (!imageUrl) {
  return res.status(400).json({
    ok: false,
    message: 'Event image is required',
  })
}

    if (!endsAt) {
      return res.status(400).json({
        ok: false,
        message: 'Valid ends_at is required',
      })
    }

    if (req.body?.starts_at && !startsAt) {
      return res.status(400).json({
        ok: false,
        message: 'starts_at is not valid',
      })
    }

    if (isPublished && !startsAt) {
      return res.status(400).json({
        ok: false,
        message: 'Published events require starts_at',
      })
    }

    if (
      startsAt &&
      new Date(endsAt).getTime() <= new Date(startsAt).getTime()
    ) {
      return res.status(400).json({
        ok: false,
        message: 'ends_at must be after starts_at',
      })
    }

    const now = new Date().toISOString()

    const { data, error } = await supabase
      .from('shadow_events')
      .insert({
        title,
        description,
        badge_text: badgeText,
        image_url: imageUrl,
        image_storage_key: imageStorageKey,
        banner_url: bannerUrl,
        banner_storage_key: bannerStorageKey,
        button_text: buttonText,
        button_url: buttonUrl,
        starts_at: startsAt,
        ends_at: endsAt,
        sort_order: sortOrder,
        is_published: isPublished,
        updated_at: now,
      })
      .select('*')
      .single()

    if (error) throw error

    invalidatePublicEventsCache()

    return res.status(201).json({
      ok: true,
      event: serializeEvent(data),
    })
  } catch (error) {
    console.error('ADMIN CREATE EVENT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to create event',
      error: error.message,
    })
  }
}

export async function updateEvent(req, res) {
  try {
    const eventId = cleanText(req.params?.eventId)

    if (!isUuid(eventId)) {
      return res.status(400).json({
        ok: false,
        message: 'Event id is not valid',
      })
    }

    const { data: current, error: currentError } = await supabase
      .from('shadow_events')
      .select('*')
      .eq('id', eventId)
      .maybeSingle()

    if (currentError) throw currentError

    if (!current) {
      return res.status(404).json({
        ok: false,
        message: 'Event not found',
      })
    }

    const patch = {}

    if (req.body?.title !== undefined) {
      const title = cleanText(req.body.title)

      if (!title) {
        return res.status(400).json({
          ok: false,
          message: 'Title is required',
        })
      }

      patch.title = title
    }

    const textFields = [
      'description',
      'badge_text',
      'image_url',
      'image_storage_key',
      'banner_url',
      'banner_storage_key',
      'button_text',
      'button_url',
    ]

    for (const field of textFields) {
      if (req.body?.[field] !== undefined) {
        patch[field] = cleanText(req.body[field])
      }
    }

    if (req.body?.starts_at !== undefined) {
      const startsAt = normalizeTimestamp(req.body.starts_at, true)

      if (req.body.starts_at && !startsAt) {
        return res.status(400).json({
          ok: false,
          message: 'starts_at is not valid',
        })
      }

      patch.starts_at = startsAt
    }

    if (req.body?.ends_at !== undefined) {
      const endsAt = normalizeTimestamp(req.body.ends_at)

      if (!endsAt) {
        return res.status(400).json({
          ok: false,
          message: 'ends_at is not valid',
        })
      }

      patch.ends_at = endsAt
    }

    if (req.body?.sort_order !== undefined) {
      const sortOrder = Number(req.body.sort_order)

      if (!Number.isInteger(sortOrder)) {
        return res.status(400).json({
          ok: false,
          message: 'sort_order must be an integer',
        })
      }

      patch.sort_order = sortOrder
    }

    if (req.body?.is_published !== undefined) {
      patch.is_published = normalizeBoolean(
        req.body.is_published,
        current.is_published
      )
    }

    if (!Object.keys(patch).length) {
      return res.status(400).json({
        ok: false,
        message: 'No event changes were provided',
      })
    }

    const finalStartsAt =
      patch.starts_at !== undefined ? patch.starts_at : current.starts_at
    const finalEndsAt =
      patch.ends_at !== undefined ? patch.ends_at : current.ends_at
    const finalPublished =
      patch.is_published !== undefined
        ? patch.is_published
        : current.is_published

    const finalImageUrl =
  patch.image_url !== undefined
    ? patch.image_url
    : current.image_url

if (!finalImageUrl) {
  return res.status(400).json({
    ok: false,
    message: 'Event image is required',
  })
}

    if (finalPublished && !finalStartsAt) {
      return res.status(400).json({
        ok: false,
        message: 'Published events require starts_at',
      })
    }

    if (
      finalStartsAt &&
      new Date(finalEndsAt).getTime() <= new Date(finalStartsAt).getTime()
    ) {
      return res.status(400).json({
        ok: false,
        message: 'ends_at must be after starts_at',
      })
    }

    patch.updated_at = new Date().toISOString()

    const { data, error } = await supabase
      .from('shadow_events')
      .update(patch)
      .eq('id', eventId)
      .select('*')
      .single()

    if (error) throw error

    invalidatePublicEventsCache()

    return res.status(200).json({
      ok: true,
      event: serializeEvent(data),
    })
  } catch (error) {
    console.error('ADMIN UPDATE EVENT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to update event',
      error: error.message,
    })
  }
}

export async function deleteEvent(req, res) {
  try {
    const eventId = cleanText(req.params?.eventId)

    if (!isUuid(eventId)) {
      return res.status(400).json({
        ok: false,
        message: 'Event id is not valid',
      })
    }

    const { data, error } = await supabase
      .from('shadow_events')
      .delete()
      .eq('id', eventId)
      .select('id')
      .maybeSingle()

    if (error) throw error

   if (!data) {
  return res.status(404).json({
    ok: false,
    message: 'Event not found',
  })
}

invalidatePublicEventsCache()

return res.status(200).json({
      ok: true,
      deleted_id: data.id,
    })
  } catch (error) {
    console.error('ADMIN DELETE EVENT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to delete event',
      error: error.message,
    })
  }
}

export async function listActiveEvents(req, res) {
  try {
    const events = await getActivePublicEvents()

    return res.status(200).json({
      ok: true,
      events: events.map(serializeEvent),
    })
  } catch (error) {
    console.error('PUBLIC LIST ACTIVE EVENTS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load active events',
      error: error.message,
    })
  }
}
