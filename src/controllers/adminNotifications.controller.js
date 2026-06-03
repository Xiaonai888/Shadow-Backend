import { supabase } from '../config/supabase.js'

function normalizeText(value) {
  return String(value || '').trim()
}

function makeReferenceId() {
  return `AN-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
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
  }
}

export async function getAdminAnnouncements(req, res) {
  try {
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
        })
      }

      const record = grouped.get(key)
      record.recipient_count += 1
      if (!item.is_read) record.unread_count += 1
    })

    return res.status(200).json({
      ok: true,
      announcements: Array.from(grouped.values()).map(publicAnnouncement).slice(0, 50),
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

    if (!title) {
      return res.status(400).json({ ok: false, message: 'Title is required' })
    }

    if (!message) {
      return res.status(400).json({ ok: false, message: 'Message is required' })
    }

    const { data: readers, error: readersError } = await supabase
      .from('users')
      .select('id')
      .limit(10000)

    if (readersError) throw readersError

    const recipientIds = (readers || [])
      .map((item) => item.id)
      .filter(Boolean)

    if (!recipientIds.length) {
      return res.status(400).json({ ok: false, message: 'No readers found' })
    }

    const referenceId = makeReferenceId()
    const rows = recipientIds.map((userId) => ({
      user_id: userId,
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
      message: 'Announcement sent',
      announcement: {
        reference_id: referenceId,
        title,
        message,
        link,
        recipient_count: insertedCount,
        unread_count: insertedCount,
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
