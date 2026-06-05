import { supabase } from '../config/supabase.js'
import { createReaderMail } from './readerMails.controller.js'

function normalizeSenderType(value) {
  return String(value || '').trim().toLowerCase() === 'admin' ? 'admin' : 'system'
}

function normalizeMailType(value) {
  const type = String(value || '').trim().toLowerCase()
  return ['admin', 'reward', 'system', 'coupon', 'event', 'payment'].includes(type) ? type : 'admin'
}

function normalizeActionType(value) {
  const actionType = String(value || '').trim().toLowerCase()
  return ['claim', 'open_link'].includes(actionType) ? actionType : ''
}

function normalizeRewardType(value) {
  const rewardType = String(value || '').trim().toLowerCase()
  return ['diamonds', 'gems', 'voucher', 'coins'].includes(rewardType) ? rewardType : ''
}

function publicAdminMail(item) {
  return {
    id: item.id,
    user_id: item.user_id,
    sender_type: item.sender_type || 'system',
    mail_type: item.mail_type || 'admin',
    title: item.title || '',
    message: item.message || '',
    detail: item.detail || '',
    action_type: item.action_type || '',
    reward_type: item.reward_type || '',
    reward_amount: Number(item.reward_amount || 0),
    link: item.link || '',
    image_url: item.image_url || '',
    reference_id: item.reference_id || '',
    is_read: Boolean(item.is_read),
    read_at: item.read_at || null,
    claimed_at: item.claimed_at || null,
    created_at: item.created_at,
    user: item.users
      ? {
          id: item.users.id,
          name: item.users.name || '',
          email: item.users.email || '',
        }
      : null,
  }
}

function getAdminName(req) {
  return (
    req.headers['x-admin-name'] ||
    req.headers['x-admin-actor'] ||
    req.admin?.name ||
    req.admin?.email ||
    'Admin'
  )
}

async function findReader({ userId, email }) {
  const identifier = String(email || '').trim().replace(/^@+/, '').toLowerCase()

  let query = supabase.from('users').select('id, name, username, email').limit(1)

  if (userId) {
    query = query.eq('id', userId)
  } else {
    query = query.or(`email.eq.${identifier},username.eq.${identifier}`)
  }

  const { data, error } = await query.maybeSingle()

  if (error) throw error

  return data || null
}

export async function searchReadersForMail(req, res) {
  try {
    const q = String(req.query.q || '').trim()
    const cleanQ = q.replace(/^@+/, '')
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 50)

    let query = supabase
      .from('users')
      .select('id, name, username, email, created_at')
      .order('created_at', { ascending: false })
      .limit(limit)

    if (cleanQ) {
      query = query.or(`name.ilike.%${cleanQ}%,username.ilike.%${cleanQ}%,email.ilike.%${cleanQ}%`)
    }

    const { data, error } = await query

    if (error) throw error

    return res.status(200).json({
      ok: true,
      readers: data || [],
    })
  } catch (error) {
    console.error('ADMIN SEARCH READERS FOR MAIL ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load readers',
      error: error.message,
    })
  }
}

export async function sendReaderMailToOne(req, res) {
  try {
    const {
      user_id,
      email,
      sender_type,
      mail_type,
      title,
      message,
      detail,
      action_type,
      reward_type,
      reward_amount,
      image_url,
      link,
    } = req.body || {}

    const cleanTitle = String(title || '').trim()
    const cleanMessage = String(message || '').trim()
    const cleanUserId = String(user_id || '').trim()
    const cleanEmail = String(email || '').trim().toLowerCase()

    if (!cleanUserId && !cleanEmail) {
      return res.status(400).json({ ok: false, message: 'Reader user_id or email is required' })
    }

    if (!cleanTitle || !cleanMessage) {
      return res.status(400).json({ ok: false, message: 'Title and message are required' })
    }

    const reader = await findReader({ userId: cleanUserId, email: cleanEmail })

    if (!reader) {
      return res.status(404).json({ ok: false, message: 'Reader not found' })
    }

    const normalizedActionType = normalizeActionType(action_type)
    const normalizedRewardType = normalizeRewardType(reward_type)
    const normalizedRewardAmount = Number(reward_amount || 0)

    if (normalizedActionType === 'claim' && (!normalizedRewardType || normalizedRewardAmount <= 0)) {
      return res.status(400).json({ ok: false, message: 'Reward type and reward amount are required for claim mail' })
    }

    const mail = await createReaderMail({
      userId: reader.id,
      senderType: normalizeSenderType(sender_type),
      mailType: normalizeMailType(mail_type),
      title: cleanTitle,
      message: cleanMessage,
      detail: detail || cleanMessage,
      actionType: normalizedActionType,
      rewardType: normalizedRewardType,
      rewardAmount: normalizedRewardAmount,
      link,
      imageUrl: image_url,
      referenceId: `admin:${getAdminName(req)}`,
    })

    if (!mail) {
      return res.status(500).json({ ok: false, message: 'Failed to send mail' })
    }

    return res.status(201).json({
      ok: true,
      mail,
      reader,
    })
  } catch (error) {
    console.error('ADMIN SEND READER MAIL ONE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to send mail',
      error: error.message,
    })
  }
}

export async function sendReaderMailToAll(req, res) {
  try {
    const {
      sender_type,
      mail_type,
      title,
      message,
      detail,
      action_type,
      reward_type,
      reward_amount,
      link,
      image_url,
    } = req.body || {}

    const cleanTitle = String(title || '').trim()
    const cleanMessage = String(message || '').trim()

    if (!cleanTitle || !cleanMessage) {
      return res.status(400).json({ ok: false, message: 'Title and message are required' })
    }

    const normalizedActionType = normalizeActionType(action_type)
    const normalizedRewardType = normalizeRewardType(reward_type)
    const normalizedRewardAmount = Number(reward_amount || 0)

    if (normalizedActionType === 'claim' && (!normalizedRewardType || normalizedRewardAmount <= 0)) {
      return res.status(400).json({ ok: false, message: 'Reward type and reward amount are required for claim mail' })
    }

    const { data: readers, error: readerError } = await supabase
      .from('users')
      .select('id')
      .limit(5000)

    if (readerError) throw readerError

    if (!readers?.length) {
      return res.status(404).json({ ok: false, message: 'No readers found' })
    }

    const now = new Date().toISOString()
    const rows = readers.map((reader) => ({
      user_id: reader.id,
      sender_type: normalizeSenderType(sender_type),
      mail_type: normalizeMailType(mail_type),
      title: cleanTitle,
      message: cleanMessage,
      detail: String(detail || cleanMessage).trim(),
      action_type: normalizedActionType,
      reward_type: normalizedRewardType,
      reward_amount: normalizedRewardAmount,
      link: String(link || '').trim(),
      image_url: String(image_url || '').trim(),
      reference_id: `admin:${getAdminName(req)}`,
      is_read: false,
      created_at: now,
    }))

    const { data, error } = await supabase
      .from('reader_mails')
      .insert(rows)
      .select('id')

    if (error) throw error

    return res.status(201).json({
      ok: true,
      sent_count: data?.length || rows.length,
    })
  } catch (error) {
    console.error('ADMIN SEND READER MAIL ALL ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to send mail to all readers',
      error: error.message,
    })
  }
}

export async function getAdminReaderMailHistory(req, res) {
  try {
    const page = Math.max(Number(req.query.page || 1), 1)
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100)
    const from = (page - 1) * limit
    const to = from + limit - 1

    const { data, error, count } = await supabase
      .from('reader_mails')
      .select('id, user_id, sender_type, mail_type, title, message, detail, action_type, reward_type, reward_amount, link, image_url, reference_id, is_read, read_at, claimed_at, created_at, users(id, name, email)', { count: 'exact' })
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      mails: (data || []).map(publicAdminMail),
      page,
      limit,
      total: Number(count || 0),
      total_pages: Math.max(Math.ceil(Number(count || 0) / limit), 1),
    })
  } catch (error) {
    console.error('ADMIN READER MAIL HISTORY ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load mail history',
      error: error.message,
    })
  }
}

export async function deleteAdminReaderMail(req, res) {
  try {
    const mailId = String(req.params.mailId || '').trim()

    if (!mailId) {
      return res.status(400).json({ ok: false, message: 'Mail ID is required' })
    }

    const { data, error } = await supabase
      .from('reader_mails')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', mailId)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({ ok: false, message: 'Mail not found' })
    }

    return res.status(200).json({
      ok: true,
      deleted_id: data.id,
    })
  } catch (error) {
    console.error('ADMIN DELETE READER MAIL ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to delete mail',
      error: error.message,
    })
  }
}
