import { supabase } from '../config/supabase.js'
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'media'

function normalizeText(value) {
  return String(value || '').trim()
}

function normalizeLookup(value) {
  return String(value || '').trim().replace(/^@+/, '').toLowerCase()
}

function makeReferenceId(targetType = 'all') {
  const prefix = targetType === 'single' ? 'AN-SG' : targetType === 'selected' ? 'AN-SE' : 'AN-ALL'
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
}

function parseRecipients(value) {
  return String(value || '')
    .split(/[\n,;]+/)
    .map((item) => normalizeLookup(item))
    .filter(Boolean)
}

function normalizeTargetType(value) {
  const targetType = String(value || 'all').trim().toLowerCase()
  return ['all', 'single', 'selected'].includes(targetType) ? targetType : 'all'
}

function targetLabel(type) {
  if (type === 'single') return 'Single reader'
  if (type === 'selected') return 'Selected readers'
  return 'All readers'
}

function getAdminIdentity(req) {
  const admin = req.admin || {}
  return {
    admin_id: String(admin.id || admin.admin_id || admin.user_id || admin.email || admin.username || ''),
    admin_email: String(admin.email || admin.username || ''),
  }
}

function clampPage(value) {
  const page = Number.parseInt(value, 10)
  return Number.isFinite(page) && page > 0 ? page : 1
}

function clampLimit(value, fallback, max) {
  const limit = Number.parseInt(value, 10)
  if (!Number.isFinite(limit) || limit < 1) return fallback
  return Math.min(limit, max)
}

function publicAnnouncement(item) {
  return {
    reference_id: item.reference_id || item.id,
    title: item.title,
    message: item.message,
    image_url: item.image_url || '',
    link: item.link || '',
    created_at: item.created_at,
    deleted_at: item.deleted_at || null,
    recipient_count: Number(item.recipient_count || 0),
    unread_count: Number(item.unread_count || 0),
    target_type: item.target_type || 'all',
    target_label: targetLabel(item.target_type || 'all'),
  }
}

async function getTotalReaderCount() {
  const { count, error } = await supabase
    .from('users')
    .select('id', { count: 'exact', head: true })

  if (error) throw error
  return Number(count || 0)
}

function inferTargetType(referenceId, recipientCount, totalReaders) {
  const value = String(referenceId || '').toUpperCase()

  if (value.startsWith('AN-SG-')) return 'single'
  if (value.startsWith('AN-SE-')) return 'selected'
  if (value.startsWith('AN-ALL-')) return 'all'
  if (recipientCount <= 1) return 'single'
  if (totalReaders > 0 && recipientCount >= totalReaders) return 'all'

  return 'selected'
}

async function findReadersByIdentifiers(identifiers) {
  const uniqueIdentifiers = Array.from(new Set(identifiers.map(normalizeLookup).filter(Boolean)))

  if (!uniqueIdentifiers.length) {
    return {
      readers: [],
      notFound: [],
    }
  }

  const { data, error } = await supabase
    .from('users')
    .select('id, email, username, name')
    .or(uniqueIdentifiers.map((item) => `email.eq.${item},username.eq.${item}`).join(','))

  if (error) throw error

  const readerMap = new Map()

  ;(data || []).forEach((reader) => {
    if (reader?.email) readerMap.set(normalizeLookup(reader.email), reader)
    if (reader?.username) readerMap.set(normalizeLookup(reader.username), reader)
  })

  const matched = new Map()
  const notFound = []

  uniqueIdentifiers.forEach((item) => {
    const reader = readerMap.get(item)

    if (reader?.id) {
      matched.set(reader.id, reader)
    } else {
      notFound.push(item)
    }
  })

  return {
    readers: Array.from(matched.values()),
    notFound,
  }
}

async function getAllReaders() {
  const { data, error } = await supabase
    .from('users')
    .select('id, email, username, name')
    .limit(10000)

  if (error) throw error

  return (data || []).filter((reader) => reader?.id)
}

async function resolveRecipients({ targetType, recipient, recipients }) {
  if (targetType === 'all') {
    const readers = await getAllReaders()

    return {
      readers,
      notFound: [],
      requested_count: readers.length,
    }
  }

  const identifiers = targetType === 'single'
    ? [recipient]
    : parseRecipients(recipients)

  const result = await findReadersByIdentifiers(identifiers)

  return {
    readers: result.readers,
    notFound: result.notFound,
    requested_count: identifiers.filter(Boolean).length,
  }
}

async function createRecord(req, { action, referenceId, title, targetType = 'all', recipientCount = 0 }) {
  const identity = getAdminIdentity(req)

  const { error } = await supabase
    .from('notification_admin_records')
    .insert({
      action,
      reference_id: referenceId,
      title,
      target_type: targetType,
      recipient_count: Number(recipientCount || 0),
      admin_id: identity.admin_id,
      admin_email: identity.admin_email,
    })

  if (error) {
    console.error('CREATE NOTIFICATION ADMIN RECORD ERROR:', error)
  }
}

async function cleanupOldRecords() {
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - 90)

  const { error } = await supabase
    .from('notification_admin_records')
    .delete()
    .lt('created_at', cutoffDate.toISOString())

  if (error) {
    console.error('CLEANUP NOTIFICATION RECORDS ERROR:', error)
  }
}

export async function uploadAdminNotificationImage(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, message: 'Image file is required' })
    }

    if (!String(req.file.mimetype || '').startsWith('image/')) {
      return res.status(400).json({ ok: false, message: 'Only image files are allowed' })
    }

    const originalName = req.file.originalname || 'notification-image'
    const fileExt = originalName.includes('.') ? originalName.split('.').pop() : 'jpg'
    const safeExt = fileExt.toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
    const fileName = `notifications/${Date.now()}-${Math.random().toString(36).slice(2)}.${safeExt}`

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        cacheControl: '3600',
        upsert: false,
      })

    if (uploadError) throw uploadError

    const { data: publicUrlData } = supabase.storage
      .from(BUCKET)
      .getPublicUrl(fileName)

    return res.status(201).json({
      ok: true,
      image_url: publicUrlData.publicUrl,
    })
  } catch (error) {
    console.error('UPLOAD NOTIFICATION IMAGE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to upload notification image',
      error: error.message,
    })
  }
}

export async function getAdminAnnouncements(req, res) {
  try {
    const page = clampPage(req.query.page)
    const limit = clampLimit(req.query.limit, 5, 20)
    const status = String(req.query.status || 'active').trim().toLowerCase()
    const totalReaders = await getTotalReaderCount()

    let query = supabase
      .from('notifications')
      .select('id, type, title, message, image_url, link, reference_id, is_read, created_at, deleted_at')
      .eq('type', 'announcements')
      .order('created_at', { ascending: false })
      .limit(10000)

    if (status === 'deleted') {
      query = query.not('deleted_at', 'is', null)
    } else {
      query = query.is('deleted_at', null)
    }

    const { data, error } = await query

    if (error) throw error

    const grouped = new Map()

    ;(data || []).forEach((item) => {
      const key = item.reference_id || item.id

      if (!grouped.has(key)) {
        grouped.set(key, {
          reference_id: key,
          title: item.title,
          message: item.message,
          image_url: item.image_url || '',
          link: item.link || '',
          created_at: item.created_at,
          deleted_at: item.deleted_at || null,
          recipient_count: 0,
          unread_count: 0,
          target_type: 'all',
        })
      }

      const record = grouped.get(key)
      record.recipient_count += 1
      if (!item.is_read) record.unread_count += 1
      record.target_type = inferTargetType(key, record.recipient_count, totalReaders)
    })

    const allAnnouncements = Array.from(grouped.values()).map(publicAnnouncement)
    const total = allAnnouncements.length
    const totalPages = Math.max(1, Math.ceil(total / limit))
    const safePage = Math.min(page, totalPages)
    const start = (safePage - 1) * limit
    const announcements = allAnnouncements.slice(start, start + limit)

    return res.status(200).json({
      ok: true,
      announcements,
      page: safePage,
      limit,
      total,
      total_pages: totalPages,
      has_next: safePage < totalPages,
      has_prev: safePage > 1,
      total_readers: totalReaders,
    })
  } catch (error) {
    console.error('GET ADMIN ANNOUNCEMENTS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load announcements',
      error: error.message,
    })
  }
}

export async function createAdminAnnouncement(req, res) {
  try {
    const title = normalizeText(req.body.title)
    const message = normalizeText(req.body.message)
    const imageUrl = normalizeText(req.body.image_url)
    const link = normalizeText(req.body.link)
    const targetType = normalizeTargetType(req.body.target_type)
    const recipient = normalizeText(req.body.recipient)
    const recipients = normalizeText(req.body.recipients)

    if (!title) {
      return res.status(400).json({ ok: false, message: 'Title is required' })
    }

    if (!message) {
      return res.status(400).json({ ok: false, message: 'Message is required' })
    }

    if (targetType === 'single' && !recipient) {
      return res.status(400).json({ ok: false, message: 'Reader email or username is required' })
    }

    if (targetType === 'selected' && !parseRecipients(recipients).length) {
      return res.status(400).json({ ok: false, message: 'Add at least one reader email or username' })
    }

    const resolved = await resolveRecipients({
      targetType,
      recipient,
      recipients,
    })

    if (!resolved.readers.length) {
      return res.status(400).json({
        ok: false,
        message: targetType === 'all' ? 'No readers found' : 'No matching readers found',
        not_found: resolved.notFound,
      })
    }

    const referenceId = makeReferenceId(targetType)
    const rows = resolved.readers.map((reader) => ({
      user_id: reader.id,
      type: 'announcements',
      title,
      message,
      image_url: imageUrl,
      link,
      reference_id: referenceId,
      is_read: false,
    }))

    const chunkSize = 500
    let insertedCount = 0

    for (let index = 0; index < rows.length; index += chunkSize) {
      const chunk = rows.slice(index, index + chunkSize)
      const { error } = await supabase.from('notifications').insert(chunk)

      if (error) throw error
      insertedCount += chunk.length
    }

    await createRecord(req, {
      action: 'SEND',
      referenceId,
      title,
      targetType,
      recipientCount: insertedCount,
    })

    return res.status(201).json({
      ok: true,
      message: resolved.notFound.length
        ? `Announcement sent to ${insertedCount} readers. ${resolved.notFound.length} not found.`
        : 'Announcement sent',
      announcement: {
        reference_id: referenceId,
        title,
        message,
        image_url: imageUrl,
        link,
        target_type: targetType,
        target_label: targetLabel(targetType),
        recipient_count: insertedCount,
        unread_count: insertedCount,
        requested_count: Number(resolved.requested_count || 0),
        not_found: resolved.notFound,
        created_at: new Date().toISOString(),
      },
    })
  } catch (error) {
    console.error('CREATE ADMIN ANNOUNCEMENT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to send announcement',
      error: error.message,
    })
  }
}

export async function updateAdminAnnouncement(req, res) {
  try {
    const referenceId = normalizeText(req.params.referenceId)
    const title = normalizeText(req.body.title)
    const message = normalizeText(req.body.message)
    const imageUrl = normalizeText(req.body.image_url)
    const link = normalizeText(req.body.link)

    if (!referenceId) {
      return res.status(400).json({ ok: false, message: 'Announcement reference is required' })
    }

    if (!title) {
      return res.status(400).json({ ok: false, message: 'Title is required' })
    }

    if (!message) {
      return res.status(400).json({ ok: false, message: 'Message is required' })
    }

    const { data: existing, error: findError } = await supabase
      .from('notifications')
      .select('reference_id, title')
      .eq('type', 'announcements')
      .eq('reference_id', referenceId)
      .is('deleted_at', null)
      .limit(1)

    if (findError) throw findError

    if (!existing?.length) {
      return res.status(404).json({ ok: false, message: 'Announcement not found' })
    }

    const { count, error } = await supabase
      .from('notifications')
      .update({
        title,
        message,
        image_url: imageUrl,
        link,
      })
      .eq('type', 'announcements')
      .eq('reference_id', referenceId)
      .is('deleted_at', null)
      .select('id', { count: 'exact', head: true })

    if (error) throw error

    await createRecord(req, {
      action: 'UPDATE',
      referenceId,
      title,
      targetType: inferTargetType(referenceId, Number(count || 0), await getTotalReaderCount()),
      recipientCount: Number(count || 0),
    })

    return res.status(200).json({
      ok: true,
      message: 'Announcement updated',
      announcement: {
        reference_id: referenceId,
        title,
        message,
        image_url: imageUrl,
        link,
        recipient_count: Number(count || 0),
      },
    })
  } catch (error) {
    console.error('UPDATE ADMIN ANNOUNCEMENT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to update announcement',
      error: error.message,
    })
  }
}

export async function deleteAdminAnnouncement(req, res) {
  try {
    const referenceId = normalizeText(req.params.referenceId)

    if (!referenceId) {
      return res.status(400).json({ ok: false, message: 'Announcement reference is required' })
    }

    const identity = getAdminIdentity(req)
    const deletedAt = new Date().toISOString()

    const { data: existing, error: findError } = await supabase
      .from('notifications')
      .select('id, title, reference_id')
      .eq('type', 'announcements')
      .eq('reference_id', referenceId)
      .is('deleted_at', null)

    if (findError) throw findError

    if (!existing?.length) {
      return res.status(404).json({ ok: false, message: 'Announcement not found' })
    }

    const title = existing[0]?.title || ''
    const { count, error } = await supabase
      .from('notifications')
      .update({
        deleted_at: deletedAt,
        deleted_by_admin: identity.admin_id || identity.admin_email || '',
      })
      .eq('type', 'announcements')
      .eq('reference_id', referenceId)
      .is('deleted_at', null)
      .select('id', { count: 'exact', head: true })

    if (error) throw error

    await createRecord(req, {
      action: 'DELETE',
      referenceId,
      title,
      targetType: inferTargetType(referenceId, Number(count || 0), await getTotalReaderCount()),
      recipientCount: Number(count || 0),
    })

    return res.status(200).json({
      ok: true,
      message: 'Announcement deleted',
      reference_id: referenceId,
      deleted_at: deletedAt,
      deleted_count: Number(count || 0),
    })
  } catch (error) {
    console.error('DELETE ADMIN ANNOUNCEMENT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to delete announcement',
      error: error.message,
    })
  }
}

export async function getAdminAnnouncementRecords(req, res) {
  try {
    await cleanupOldRecords()

    const page = clampPage(req.query.page)
    const limit = clampLimit(req.query.limit, 20, 50)
    const start = (page - 1) * limit
    const end = start + limit - 1

    const { data, error, count } = await supabase
      .from('notification_admin_records')
      .select('id, action, reference_id, title, target_type, recipient_count, admin_id, admin_email, created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(start, end)

    if (error) throw error

    const total = Number(count || 0)
    const totalPages = Math.max(1, Math.ceil(total / limit))

    return res.status(200).json({
      ok: true,
      records: data || [],
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
      history_limit_days: 90,
    })
  } catch (error) {
    console.error('GET NOTIFICATION RECORDS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load notification records',
      error: error.message,
    })
  }
}
