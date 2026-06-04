import { supabase } from '../config/supabase.js'

const MAIL_RETENTION_DAYS = 365

function getUserId(req) {
  return req.user?.user_id || req.user?.id || null
}

function normalizeMailType(value) {
  const type = String(value || '').trim().toLowerCase()
  return ['admin', 'reward', 'system', 'coupon', 'event', 'payment'].includes(type) ? type : 'admin'
}

function publicMail(item) {
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
  }
}

function buildCounts(items) {
  return {
    all: items.length,
    unread: items.filter((item) => !item.is_read).length,
    rewards: items.filter((item) => item.mail_type === 'reward').length,
    admin: items.filter((item) => item.mail_type === 'admin').length,
    system: items.filter((item) => item.mail_type === 'system' || item.sender_type === 'system').length,
  }
}

async function cleanupOldMails(userId) {
  if (!userId) return

  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - MAIL_RETENTION_DAYS)

  const { error } = await supabase
    .from('reader_mails')
    .update({ deleted_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('deleted_at', null)
    .lt('created_at', cutoffDate.toISOString())

  if (error) {
    console.error('CLEANUP OLD READER MAILS ERROR:', error)
  }
}

async function getOrCreateWallet(userId) {
  const { data: existingWallet, error: existingError } = await supabase
    .from('user_wallets')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()

  if (existingError) throw existingError
  if (existingWallet) return existingWallet

  const { data, error } = await supabase
    .from('user_wallets')
    .insert({ user_id: userId, diamond_balance: 0, gem_balance: 0 })
    .select('*')
    .single()

  if (error) throw error

  return data
}

async function applyReward(userId, mail) {
  const rewardType = String(mail.reward_type || '').trim().toLowerCase()
  const rewardAmount = Number(mail.reward_amount || 0)

  if (!rewardType || rewardAmount <= 0) {
    return null
  }

  const now = new Date().toISOString()
  const wallet = await getOrCreateWallet(userId)

  if (rewardType === 'diamonds') {
    const { data, error } = await supabase
      .from('user_wallets')
      .update({
        diamond_balance: Number(wallet.diamond_balance || 0) + rewardAmount,
        updated_at: now,
      })
      .eq('user_id', userId)
      .select('*')
      .single()

    if (error) throw error
    return data
  }

  if (rewardType === 'gems' || rewardType === 'coins') {
    const { data, error } = await supabase
      .from('user_wallets')
      .update({
        gem_balance: Number(wallet.gem_balance || 0) + rewardAmount,
        updated_at: now,
      })
      .eq('user_id', userId)
      .select('*')
      .single()

    if (error) throw error
    return data
  }

  return wallet
}

export async function getMyMails(req, res) {
  try {
    const userId = getUserId(req)
    const type = String(req.query.type || 'all').trim().toLowerCase()

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    await cleanupOldMails(userId)

    let query = supabase
      .from('reader_mails')
      .select('id, user_id, sender_type, mail_type, title, message, detail, action_type, reward_type, reward_amount, link, image_url, reference_id, is_read, read_at, claimed_at, created_at')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(80)

    if (type === 'unread') {
      query = query.eq('is_read', false)
    } else if (type === 'rewards') {
      query = query.eq('mail_type', 'reward')
    } else if (type === 'admin') {
      query = query.eq('mail_type', 'admin')
    } else if (type === 'system') {
      query = query.eq('sender_type', 'system')
    } else if (type !== 'all') {
      query = query.eq('mail_type', normalizeMailType(type))
    }

    const { data, error } = await query

    if (error) throw error

    const { data: countRows, error: countError } = await supabase
      .from('reader_mails')
      .select('id, sender_type, mail_type, is_read')
      .eq('user_id', userId)
      .is('deleted_at', null)
      .limit(500)

    if (countError) throw countError

    return res.status(200).json({
      ok: true,
      mails: (data || []).map(publicMail),
      counts: buildCounts(countRows || []),
    })
  } catch (error) {
    console.error('GET MY MAILS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load mails',
      error: error.message,
    })
  }
}

export async function getMyMailUnreadCount(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    await cleanupOldMails(userId)

    const { count, error } = await supabase
      .from('reader_mails')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('is_read', false)
      .is('deleted_at', null)

    if (error) throw error

    return res.status(200).json({
      ok: true,
      unread_count: Number(count || 0),
    })
  } catch (error) {
    console.error('GET MAIL UNREAD COUNT ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load mail count',
      error: error.message,
    })
  }
}

export async function markMailAsRead(req, res) {
  try {
    const userId = getUserId(req)
    const mailId = String(req.params.mailId || '').trim()

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!mailId) {
      return res.status(400).json({ ok: false, message: 'Mail ID is required' })
    }

    const { data, error } = await supabase
      .from('reader_mails')
      .update({
        is_read: true,
        read_at: new Date().toISOString(),
      })
      .eq('id', mailId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .select('id, user_id, sender_type, mail_type, title, message, detail, action_type, reward_type, reward_amount, link, reference_id, is_read, read_at, claimed_at, created_at')
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(404).json({ ok: false, message: 'Mail not found' })
    }

    return res.status(200).json({
      ok: true,
      mail: publicMail(data),
    })
  } catch (error) {
    console.error('MARK MAIL READ ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to mark mail as read',
      error: error.message,
    })
  }
}

export async function claimMailReward(req, res) {
  try {
    const userId = getUserId(req)
    const mailId = String(req.params.mailId || '').trim()

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' })
    }

    if (!mailId) {
      return res.status(400).json({ ok: false, message: 'Mail ID is required' })
    }

    const { data: mail, error: mailError } = await supabase
      .from('reader_mails')
      .select('*')
      .eq('id', mailId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .maybeSingle()

    if (mailError) throw mailError

    if (!mail) {
      return res.status(404).json({ ok: false, message: 'Mail not found' })
    }

    if (mail.action_type !== 'claim') {
      return res.status(400).json({ ok: false, message: 'This mail has no claim action' })
    }

    if (mail.claimed_at) {
      return res.status(200).json({
        ok: true,
        already_claimed: true,
        mail: publicMail(mail),
      })
    }

    const wallet = await applyReward(userId, mail)
    const now = new Date().toISOString()

    const { data: updatedMail, error: updateError } = await supabase
      .from('reader_mails')
      .update({
        is_read: true,
        read_at: mail.read_at || now,
        claimed_at: now,
      })
      .eq('id', mailId)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .select('id, user_id, sender_type, mail_type, title, message, detail, action_type, reward_type, reward_amount, link, reference_id, is_read, read_at, claimed_at, created_at')
      .single()

    if (updateError) throw updateError

    return res.status(200).json({
      ok: true,
      already_claimed: false,
      mail: publicMail(updatedMail),
      wallet,
    })
  } catch (error) {
    console.error('CLAIM MAIL REWARD ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to claim mail reward',
      error: error.message,
    })
  }
}

export async function createReaderMail({
  userId,
  senderType = 'system',
  mailType = 'admin',
  title,
  message,
  detail = '',
  actionType = '',
  rewardType = '',
  rewardAmount = 0,
  link = '',
  imageUrl = '',
  referenceId = '',
}) {
  if (!userId || !title || !message) return null

  const { data, error } = await supabase
    .from('reader_mails')
    .insert({
      user_id: userId,
      sender_type: String(senderType || 'system').trim().toLowerCase() === 'admin' ? 'admin' : 'system',
      mail_type: normalizeMailType(mailType),
      title: String(title || '').trim(),
      message: String(message || '').trim(),
      detail: String(detail || '').trim(),
      action_type: String(actionType || '').trim().toLowerCase(),
      reward_type: String(rewardType || '').trim().toLowerCase(),
      reward_amount: Number(rewardAmount || 0),
      link: String(link || '').trim(),
      image_url: String(imageUrl || '').trim(),
      reference_id: String(referenceId || '').trim(),
      is_read: false,
    })
    .select('id, user_id, sender_type, mail_type, title, message, detail, action_type, reward_type, reward_amount, link, reference_id, is_read, read_at, claimed_at, created_at')
    .single()

  if (error) {
    console.error('CREATE READER MAIL ERROR:', error)
    return null
  }

  return publicMail(data)
}
