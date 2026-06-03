import { supabase } from '../config/supabase.js'

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

function publicAnnouncement(item) {
  return {
    reference_id: item.reference_id || item.id,
    title: item.title,
    message: item.message,
    link: item.link || '',
    created_at: item.created_at,
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

export async function getAdminAnnouncements(req, res) {
  try {
    const totalReaders = await getTotalReaderCount()

    const { data, error } = await supabase
      .from('notifications')
      .select('id, type, title, message, link, reference_id, is_read, created_at')
      .eq('type', 'announcements')
      .order('created_at', { ascending: false })
      .limit(500)

    if (error) throw error

    const grouped = new Map()

    ;(data || []).forEach((item) => {
      const key = item.reference_id || item.id

      if (!grouped.has(key)) {
        grouped.set(key, {
          reference_id: key,
          title: item.title,
          message: item.message,
          link: item.link || '',
          created_at: item.created_at,
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

    return res.status(200).json({
      ok: true,
      announcements: Array.from(grouped.values()).map(publicAnnouncement).slice(0, 50),
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

    return res.status(201).json({
      ok: true,
      message: resolved.notFound.length
        ? `Announcement sent to ${insertedCount} readers. ${resolved.notFound.length} not found.`
        : 'Announcement sent',
      announcement: {
        reference_id: referenceId,
        title,
        message,
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
