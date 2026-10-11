import { supabase } from '../config/supabase.js'

const DAY_MS = 24 * 60 * 60 * 1000
const SELECT_FIELDS = 'id,user_id,order_id,package_usd,amount_usd,currency,diamonds,bonus_gems,purchase_type,premium_plan_months,premium_base_diamonds,premium_bonus_diamonds,payment_method,status,match_status,match_reason,aba_trx_id,aba_apv,payer_name,created_at,expires_at,paid_at,released_at,updated_at'
const SUCCESS_STATUSES = ['success', 'approved', 'confirmed']
const FILTER_STATUSES = new Set(['all', 'released', 'unreleased', 'waiting_payment', 'pending_review', 'expired', 'cancelled', 'rejected', 'failed', 'callback_received', 'success'])

function safeSearch(value) {
  return String(value || '').trim().slice(0, 80).replace(/[(),%*;"\\]/g, ' ').trim()
}

function validDate(value) {
  const date = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  return !Number.isNaN(Date.parse(`${date}T00:00:00+07:00`))
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

async function matchingUserIds(term) {
  const pattern = `%${term}%`
  const { data, error } = await supabase
    .from('users')
    .select('id')
    .or(`username.ilike.${pattern},name.ilike.${pattern},email.ilike.${pattern}`)
    .limit(50)
  if (error) throw error
  return (data || []).map((user) => user.id)
}

export async function getAdminPaymentRecovery(req, res) {
  try {
    const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), 100)
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50)
    const rawSearch = String(req.query.q || '').trim()
    const search = safeSearch(rawSearch)
    const status = String(req.query.status || 'all').trim().toLowerCase()
    const date = String(req.query.date || '').trim()
    const amountRaw = String(req.query.amount || '').trim()

    if ((rawSearch && !search) || !FILTER_STATUSES.has(status)) {
      return res.status(400).json({ ok: false, message: 'Invalid recovery search or status.' })
    }
    if (date && !validDate(date)) {
      return res.status(400).json({ ok: false, message: 'Date must be YYYY-MM-DD.' })
    }
    if (amountRaw && (!/^\d+(?:\.\d{1,2})?$/.test(amountRaw) || Number(amountRaw) > 100000)) {
      return res.status(400).json({ ok: false, message: 'Invalid USD amount.' })
    }

    let query = supabase
      .from('payment_transactions')
      .select(SELECT_FIELDS)
      .order('created_at', { ascending: false })

    if (search) {
      const userIds = await matchingUserIds(search)
      const filters = [
        `order_id.ilike.%${search}%`,
        `payer_name.ilike.%${search}%`,
        `aba_trx_id.ilike.%${search}%`,
      ]
      if (isUuid(search)) filters.push(`user_id.eq.${search}`)
      if (userIds.length) filters.push(`user_id.in.(${userIds.join(',')})`)
      query = query.or(filters.join(','))
    }

    if (status === 'released') {
      query = query.or(`status.in.(${SUCCESS_STATUSES.join(',')}),released_at.not.is.null`)
    } else if (status === 'unreleased') {
      query = query.not('status', 'in', `(${SUCCESS_STATUSES.join(',')})`).is('released_at', null)
    } else if (status === 'success') {
      query = query.in('status', SUCCESS_STATUSES)
    } else if (status !== 'all') {
      query = query.eq('status', status)
    }

    if (amountRaw) query = query.eq('amount_usd', Number(amountRaw))

    if (date) {
      const dayStart = new Date(`${date}T00:00:00+07:00`)
      query = query.gte('created_at', dayStart.toISOString())
        .lt('created_at', new Date(dayStart.getTime() + DAY_MS).toISOString())
    } else if (!search) {
      query = query.gte('created_at', new Date(Date.now() - 30 * DAY_MS).toISOString())
    }

    const start = (page - 1) * limit
    const { data, error } = await query.range(start, start + limit)
    if (error) throw error

    const rows = data || []
    const pageRows = rows.slice(0, limit)
    const userIds = [...new Set(pageRows.map((payment) => payment.user_id).filter(Boolean))]
    let users = []

    if (userIds.length) {
      const result = await supabase
        .from('users')
        .select('id,name,username,email,avatar_url')
        .in('id', userIds)
      if (result.error) throw result.error
      users = result.data || []
    }

    const userMap = new Map(users.map((user) => [user.id, user]))
    const payments = pageRows.map((payment) => ({
      ...payment,
      user: userMap.get(payment.user_id) || null,
      released: SUCCESS_STATUSES.includes(String(payment.status || '').toLowerCase()) || Boolean(payment.released_at),
    }))

    return res.status(200).json({
      ok: true,
      payments,
      page,
      limit,
      has_next: rows.length > limit,
      has_prev: page > 1,
      read_only: true,
    })
  } catch (error) {
    console.error('ADMIN PAYMENT RECOVERY SEARCH ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to search payments.' })
  }
}
