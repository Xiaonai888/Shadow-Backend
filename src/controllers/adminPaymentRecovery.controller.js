import { supabase } from '../config/supabase.js'
import { verifyAdminPasskeyPin } from '../services/adminPasskeyPin.service.js'
import { publishPaymentStatus } from '../services/paymentEvents.service.js'

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
    const rawSearch = String(req.query.q || '').trim().replace(/^@+/, '')
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


function adminIdentity(req) {
  const role = String(req.admin?.role || '').trim().toLowerCase()
  const id = String(req.admin?.admin_id || req.admin?.id || req.admin?.email || '').trim()
  const email = String(req.admin?.email || '').trim().toLowerCase()
  return { permitted: ['owner', 'admin'].includes(role), id, email }
}

function validReference(value) {
  return /^[a-z0-9][a-z0-9._/-]{5,99}$/i.test(String(value || '').trim())
}

function validationError(res, message) {
  return res.status(400).json({ ok: false, message })
}

function actionFailure(res, error) {
  const message = String(error?.message || '')
  const known = [
    'already', 'not eligible', 'does not belong', 'not match', 'not found',
    'required', 'Invalid', 'different', 'cannot', 'Unsupported', 'must',
    'unique', 'not complete', 'not assigned', 'was used', 'did not complete',
    'payment status', 'wallet', 'ABA reference', 'Payment release',
    'Payment is', 'Recipient', 'This bank', 'Order', 'Enter', 'Manual top-up'
  ]
  const safe = known.some((fragment) => message.toLowerCase().includes(fragment.toLowerCase()))
  if (safe && error?.code === 'P0001') {
    return res.status(409).json({ ok: false, message })
  }
  console.error('ADMIN PAYMENT RECOVERY WRITE ERROR:', error)
  return res.status(500).json({ ok: false, message: 'Unable to complete payment action. No success was reported.' })
}

async function ensureVerifiedPin(req, res, purpose) {
  const value = String(req.body?.passkey || '').trim()
  if (!/^\d{6}$/.test(value)) {
    res.status(400).json({ ok: false, message: 'Enter the six-digit Admin Passkey' })
    return false
  }
  const result = await verifyAdminPasskeyPin({ admin: req.admin, req, pin: value, purpose })
  if (!result.ok) {
    res.status(result.status || 403).json({ ok: false, message: result.message || 'Passkey verification failed', code: result.code })
    return false
  }
  return true
}

export async function getAdminPaymentRecoveryRecipient(req, res) {
  try {
    const raw = String(req.query.q || '').trim().replace(/^@+/, '')
    const q = safeSearch(raw)
    if (q.length < 2 || q.length > 80 || !q) return validationError(res, 'Enter at least two characters to find a recipient')

    let usersQuery = supabase.from('users').select('id,name,username,email,avatar_url').limit(10)
    if (isUuid(q)) usersQuery = usersQuery.eq('id', q)
    else usersQuery = usersQuery.or(`username.ilike.%${q}%,name.ilike.%${q}%,email.ilike.%${q}%`)
    const { data: users, error } = await usersQuery
    if (error) throw error

    const ids = (users || []).map((user) => user.id)
    let wallets = []
    if (ids.length) {
      const walletResult = await supabase.from('user_wallets').select('user_id,diamond_balance').in('user_id', ids)
      if (walletResult.error) throw walletResult.error
      wallets = walletResult.data || []
    }
    const balances = new Map(wallets.map((wallet) => [wallet.user_id, Number(wallet.diamond_balance || 0)]))
    return res.status(200).json({
      ok: true,
      users: (users || []).map((user) => ({ ...user, diamond_balance: balances.get(user.id) || 0 })),
    })
  } catch (error) {
    console.error('ADMIN PAYMENT RECOVERY RECIPIENT LOOKUP ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Failed to search recipient accounts' })
  }
}

export async function getAdminPaymentRecoveryHistory(req, res) {
  try {
    const page = Math.min(Math.max(Number.parseInt(req.query.page, 10) || 1, 1), 100)
    const limit = 20
    const { data, error } = await supabase
      .from('admin_payment_recovery_actions')
      .select('id,action_type,payment_id,user_id,reference,diamonds,amount_usd,bank_paid_at,balance_before,balance_after,admin_email,reason,created_at')
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit)
    if (error) throw error
    const rows = (data || []).slice(0, limit)
const ids = [...new Set(rows.map(row => row.user_id).filter(Boolean))]
const lookup = ids.length ? await supabase.from('users').select('id,name,username').in('id', ids) : { data: [] }
const names = new Map((lookup.data || []).map(user => [user.id, String(user.name || '').trim() || String(user.username || '').trim()]))
const items = rows.map(row => ({ ...row, user_name: names.get(row.user_id) || null }))
return res.status(200).json({ ok: true, items, page, has_next: (data || []).length > limit, has_prev: page > 1 })
  } catch (error) {
    console.error('ADMIN PAYMENT RECOVERY HISTORY ERROR:', error)
    return res.status(500).json({ ok: false, message: 'Unable to load recovery history. Install the SQL setup first.' })
  }
}

export async function confirmAdminPaymentRecovery(req, res) {
  try {
    const admin = adminIdentity(req)
    if (!admin.permitted || !admin.id || !admin.email) return res.status(403).json({ ok: false, message: 'Owner/Admin account with an email is required' })
    const paymentId = String(req.params.paymentId || '').trim()
    const userId = String(req.body?.user_id || '').trim()
    const reference = String(req.body?.reference || '').trim()
    const reason = String(req.body?.reason || '').trim()
    const usd = Number(req.body?.verified_amount_usd)
    const time = String(req.body?.bank_paid_at || '').trim()
    const paidAt = new Date(time)

    if (!isUuid(paymentId) || !isUuid(userId)) return validationError(res, 'Select a valid payment order and account')
    if (!validReference(reference)) return validationError(res, 'Enter the ABA transaction reference (6-100 letters or digits)')
    if (reason.length < 12 || reason.length > 500) return validationError(res, 'Enter a reason between 12 and 500 characters')
    if (!Number.isFinite(usd) || usd <= 0 || usd > 100000) return validationError(res, 'Enter the ABA amount shown in bank records')
    if (!time || Number.isNaN(paidAt.getTime())) return validationError(res, 'Enter the ABA transaction date and time')
    if (req.body?.bank_verified !== true || req.body?.confirm_recipient !== true) return validationError(res, 'Confirm bank settlement and the correct recipient')

    const verified = await ensureVerifiedPin(req, res, 'payment_recovery:' + paymentId)
    if (!verified) return

    const { data, error } = await supabase.rpc('admin_payment_recovery_apply_v1', {
      p_action: 'recovery',
      p_payment_id: paymentId,
      p_user_id: userId,
      p_diamonds: null,
      p_reference: reference,
      p_verified_usd: usd,
      p_bank_paid_at: paidAt.toISOString(),
      p_admin_id: admin.id,
      p_admin_email: admin.email,
      p_note: reason,
    })
    if (error) return actionFailure(res, error)

    const result = await supabase.from('payment_transactions').select('id,user_id,order_id,status,diamonds,bonus_gems,released_at,updated_at').eq('id', paymentId).maybeSingle()
    if (!result.error && result.data) publishPaymentStatus(result.data)
    res.set('Cache-Control', 'no-store')
    return res.status(200).json({ ok: true, result: data, payment: result.data || null })
  } catch (error) {
    return actionFailure(res, error)
  }
}

export async function confirmAdminManualTopUp(req, res) {
  try {
    const admin = adminIdentity(req)
    if (!admin.permitted || !admin.id || !admin.email) return res.status(403).json({ ok: false, message: 'Owner/Admin account with an email is required' })
    const userId = String(req.body?.user_id || '').trim()
    const reference = String(req.body?.reference || '').trim()
    const diamonds = Number(req.body?.diamonds)
    const reason = String(req.body?.reason || '').trim()
    if (!isUuid(userId)) return validationError(res, 'Select the recipient from the account search')
    if (!Number.isSafeInteger(diamonds) || diamonds < 1 || diamonds > 10000) return validationError(res, 'Diamonds must be 1 to 10,000')
    if (!validReference(reference)) return validationError(res, 'Enter a unique ABA or adjustment reference (6-100 characters)')
    if (reason.length < 12 || reason.length > 500) return validationError(res, 'Enter a detailed reason between 12 and 500 characters')
    if (req.body?.confirmed !== true) return validationError(res, 'Confirm the recipient and the reason for this manual top-up')

    const verified = await ensureVerifiedPin(req, res, 'manual_topup:' + userId + ':' + reference)
    if (!verified) return

    const { data, error } = await supabase.rpc('admin_payment_recovery_apply_v1', {
      p_action: 'topup',
      p_payment_id: null,
      p_user_id: userId,
      p_diamonds: diamonds,
      p_reference: reference,
      p_verified_usd: null,
      p_bank_paid_at: null,
      p_admin_id: admin.id,
      p_admin_email: admin.email,
      p_note: reason,
    })
    if (error) return actionFailure(res, error)
    res.set('Cache-Control', 'no-store')
    return res.status(200).json({ ok: true, result: data })
  } catch (error) {
    return actionFailure(res, error)
  }
}
