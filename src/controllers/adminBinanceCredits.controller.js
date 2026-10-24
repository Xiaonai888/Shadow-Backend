import { supabase } from '../config/supabase.js'
import { verifyAdminPasskeyPin } from '../services/adminPasskeyPin.service.js'

const PAGE_LIMIT = 10
const MAX_PAGE = 100000
const DAY_MS = 24 * 60 * 60 * 1000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TRANSACTION_RE = /^[A-Za-z0-9_-]{1,128}$/
const TOPUP_REFERENCE_RE = /^[A-Z0-9][A-Z0-9._/-]{5,99}$/
const DISPLAY_REFERENCE_RE = /^[A-Z0-9][A-Z0-9._/-]{0,127}$/
const USDT_RE = /^(?:0|[1-9]\d{0,17})(?:\.\d{1,8})?$/
const ACTION_FIELDS = 'id,action_type,transaction_id,user_id,reference,amount_usdt,diamonds,bonus_vouchers,diamond_balance_before,diamond_balance_after,voucher_balance_before,voucher_balance_after,admin_id,admin_email,reason,created_at'
const METADATA_FIELDS = 'action_id,display_reference,mark_note,edit_count,updated_by_id,updated_by_email,updated_at'
const EDIT_FIELDS = 'id,action_id,old_reference,new_reference,old_mark,new_mark,edit_number,reason,admin_id,admin_email,created_at'

function authorize(req, res) {
  const role = String(req.admin?.role || '').trim().toLowerCase()
  const id = String(req.admin?.admin_id || req.admin?.id || req.admin?.email || '').trim()
  const email = String(req.admin?.email || '').trim().toLowerCase()
  if (!['owner', 'admin'].includes(role) || !id || !email) {
    res.status(403).json({ ok: false, message: 'Owner/Admin account with email is required' })
    return null
  }
  res.set('Cache-Control', 'no-store')
  return { id, email }
}

function bad(res, message) {
  return res.status(400).json({ ok: false, message })
}

function readPage(value) {
  const page = Number.parseInt(String(value || '1'), 10)
  return Number.isSafeInteger(page) ? Math.max(1, Math.min(MAX_PAGE, page)) : 1
}

function readDiamonds(value) {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && /^\d{1,5}$/.test(value.trim())) return Number(value.trim())
  return NaN
}

function safeSearch(value) {
  const raw = String(value || '').trim()
  if (raw.length > 80) throw new RangeError('Search must be 80 characters or fewer')
  const q = raw.replace(/[^\p{L}\p{N}\s._/@-]/gu, ' ').replace(/\s+/g, ' ').trim()
  if (raw && !q) throw new RangeError('Invalid search')
  return q
}

function readDate(value) {
  const date = String(value || '').trim()
  if (!date) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RangeError('Date must be YYYY-MM-DD')
  const start = Date.parse(date + 'T00:00:00+07:00')
  if (!Number.isSafeInteger(start) || new Date(start + 7 * 60 * 60 * 1000).toISOString().slice(0, 10) !== date) {
    throw new RangeError('Invalid Cambodia date')
  }
  return start
}

function readId(req, res) {
  const id = String(req.params.actionId || '').trim()
  if (!UUID_RE.test(id)) {
    bad(res, 'Invalid Binance credit action ID')
    return null
  }
  return id
}

async function requirePasskey(req, res, purpose) {
  const pin = typeof req.body?.passkey === 'string' ? req.body.passkey.trim() : ''
  if (!/^\d{6}$/.test(pin)) {
    bad(res, 'Enter the six-digit Admin Passkey')
    return false
  }
  const verified = await verifyAdminPasskeyPin({ admin: req.admin, req, pin, purpose })
  if (!verified.ok) {
    res.status(verified.status || 403).json({
      ok: false,
      code: verified.code || 'PASSKEY_VERIFICATION_FAILED',
      message: verified.message || 'Admin Passkey verification failed',
    })
    return false
  }
  return true
}

function fail(res, error, context) {
  const code = String(error?.code || '')
  const detail = String(error?.message || '')
  if (code === 'P0001') {
    const messages = [
      ['not found', 404, 'Binance receipt, account or credit action was not found'],
      ['another admin', 409, 'Another admin edited this action. Refresh and retry'],
      ['already', 409, 'Binance transaction or reference has already been used'],
      ['different', 409, 'Reference conflicts with an existing payment'],
      ['assigned', 409, 'Reference is assigned to another payment'],
      ['did not match', 409, 'Wallet balance change failed verification'],
      ['does not match', 409, 'Verified USDT amount does not match the recorded receipt'],
      ['No information was changed', 409, 'No information was changed'],
      ['Invalid', 400, 'Invalid credit information'],
      ['required', 400, 'Required credit information is missing'],
      ['must', 400, 'Credit value is outside the allowed range'],
      ['cannot', 400, 'This credit action is not permitted'],
    ]
    const found = messages.find(([key]) => detail.toLowerCase().includes(key.toLowerCase()))
    if (found) return res.status(found[1]).json({ ok: false, message: found[2] })
  }
  if (code === '23505') return res.status(409).json({ ok: false, message: 'Transaction or reference has already been credited' })
  if (code === 'PGRST202' || code === '42883' || code === '42P01') {
    return res.status(503).json({ ok: false, message: 'Install the Binance Credit Ledger SQL before enabling credit actions' })
  }
  console.error('ADMIN BINANCE CREDIT ERROR:', context, code, detail.slice(0, 240))
  return res.status(500).json({ ok: false, message: 'Unable to complete the Binance action. No success was reported' })
}

async function loadEdits(actionId, page) {
  const from = (page - 1) * PAGE_LIMIT
  const { data, error } = await supabase
    .from('admin_binance_usdt_credit_action_edits')
    .select(EDIT_FIELDS)
    .eq('action_id', actionId)
    .order('edit_number', { ascending: false })
    .range(from, from + PAGE_LIMIT)
  if (error) throw error
  const rows = data || []
  return {
    items: rows.slice(0, PAGE_LIMIT),
    page,
    limit: PAGE_LIMIT,
    has_next: rows.length > PAGE_LIMIT,
    has_prev: page > 1,
  }
}

async function recipientNames(ids) {
  if (!ids.length) return new Map()
  const { data, error } = await supabase
    .from('users')
    .select('id,name,username,email,avatar_url')
    .in('id', ids)
    .limit(PAGE_LIMIT)
  if (error) throw error
  return new Map((data || []).map((user) => [user.id, user]))
}

export async function getAdminBinanceCreditAvailability(req, res) {
  if (!authorize(req, res)) return
  try {
    const { error } = await supabase.from('admin_binance_usdt_credit_actions').select('id').limit(1)
    return res.status(200).json({
      ok: true,
      verified_receipt_credit_enabled: !error,
      manual_top_up_enabled: !error,
      automatic_credit_enabled: false,
      bonus_vouchers_per_verified_purchase: 100,
      records_per_page: PAGE_LIMIT,
      message: error ? 'Install Binance Credit Ledger SQL before enabling credit actions' : 'Verified receipt credits require an Admin Passkey and explicit recipient confirmation',
    })
  } catch (error) {
    return fail(res, error, 'availability')
  }
}

export async function getAdminBinanceCreditHistory(req, res) {
  if (!authorize(req, res)) return
  let q
  let start
  try {
    q = safeSearch(req.query.q)
    start = readDate(req.query.date)
  } catch (error) {
    return bad(res, error.message)
  }
  const type = String(req.query.type || 'all').trim().toLowerCase()
  const sort = String(req.query.sort || 'newest').trim().toLowerCase()
  if (!['all', 'recovery', 'topup'].includes(type) || !['newest', 'oldest', 'high', 'low'].includes(sort)) {
    return bad(res, 'Invalid credit history filter')
  }
  const page = readPage(req.query.page)
  const from = (page - 1) * PAGE_LIMIT
  try {
    let query = supabase.from('admin_binance_usdt_credit_actions').select(ACTION_FIELDS)
    if (type !== 'all') query = query.eq('action_type', type)
    if (start !== null) {
      query = query.gte('created_at', new Date(start).toISOString())
        .lt('created_at', new Date(start + DAY_MS).toISOString())
    } else if (!q) {
      query = query.gte('created_at', new Date(Date.now() - 30 * DAY_MS).toISOString())
    }
    if (q) {
      const userQuery = await supabase.from('users')
        .select('id')
        .or('name.ilike.%' + q + '%,username.ilike.%' + q + '%,email.ilike.%' + q + '%')
        .limit(20)
      if (userQuery.error) throw userQuery.error
      const ids = (userQuery.data || []).map((user) => user.id)
      const clauses = ['reference.ilike.%' + q + '%', 'admin_email.ilike.%' + q + '%']
      if (/^[A-Za-z0-9_-]+$/.test(q)) clauses.push('transaction_id.ilike.%' + q + '%')
      if (UUID_RE.test(q)) clauses.push('user_id.eq.' + q)
      if (ids.length) clauses.push('user_id.in.(' + ids.join(',') + ')')
      query = query.or(clauses.join(','))
    }
    if (sort === 'high' || sort === 'low') {
      query = query.order('amount_usdt', { ascending: sort === 'low', nullsFirst: false })
    }
    query = query.order('created_at', { ascending: sort === 'oldest' })
      .order('id', { ascending: sort === 'oldest' })
      .range(from, from + PAGE_LIMIT)
    const { data, error } = await query
    if (error) throw error
    const rows = data || []
    const pageRows = rows.slice(0, PAGE_LIMIT)
    const userIds = [...new Set(pageRows.map((row) => row.user_id).filter(Boolean))]
    const actionIds = pageRows.map((row) => row.id)
    const [users, marks] = await Promise.all([
      recipientNames(userIds),
      actionIds.length
        ? supabase.from('admin_binance_usdt_credit_action_metadata')
          .select(METADATA_FIELDS).in('action_id', actionIds).limit(PAGE_LIMIT)
        : Promise.resolve({ data: [], error: null }),
    ])
    if (marks.error) throw marks.error
    const metadata = new Map((marks.data || []).map((item) => [item.action_id, item]))
    const items = pageRows.map((row) => {
      const mark = metadata.get(row.id)
      return {
        ...row,
        user: users.get(row.user_id) || null,
        user_name: users.get(row.user_id)?.name || users.get(row.user_id)?.username || null,
        display_reference: mark?.display_reference || row.reference,
        mark_note: mark?.mark_note || '',
        edit_count: Number(mark?.edit_count || 0),
        edited_at: mark?.updated_at || null,
      }
    })
    return res.status(200).json({
      ok: true, items, page, limit: PAGE_LIMIT,
      has_next: rows.length > PAGE_LIMIT, has_prev: page > 1,
      currency: 'USDT',
      automatic_credit_enabled: false,
    })
  } catch (error) {
    return fail(res, error, 'history')
  }
}

export async function getAdminBinanceCreditActionDetails(req, res) {
  if (!authorize(req, res)) return
  const id = readId(req, res)
  if (!id) return
  try {
    const result = await supabase
      .from('admin_binance_usdt_credit_actions')
      .select(ACTION_FIELDS)
      .eq('id', id).maybeSingle()
    if (result.error) throw result.error
    if (!result.data) return res.status(404).json({ ok: false, message: 'Binance credit action was not found' })
    const [mark, users, edits] = await Promise.all([
      supabase.from('admin_binance_usdt_credit_action_metadata')
        .select(METADATA_FIELDS).eq('action_id', id).maybeSingle(),
      recipientNames([result.data.user_id]),
      loadEdits(id, 1),
    ])
    if (mark.error) throw mark.error
    const metadata = mark.data
    return res.status(200).json({
      ok: true,
      action: {
        ...result.data,
        user: users.get(result.data.user_id) || null,
        user_name: users.get(result.data.user_id)?.name || users.get(result.data.user_id)?.username || null,
        display_reference: metadata?.display_reference || result.data.reference,
        mark_note: metadata?.mark_note || '',
        edit_count: Number(metadata?.edit_count || 0),
        edited_at: metadata?.updated_at || null,
        updated_by_email: metadata?.updated_by_email || null,
      },
      edits,
    })
  } catch (error) {
    return fail(res, error, 'action_details')
  }
}

export async function getAdminBinanceCreditActionEdits(req, res) {
  if (!authorize(req, res)) return
  const id = readId(req, res)
  if (!id) return
  try {
    const existing = await supabase
      .from('admin_binance_usdt_credit_actions')
      .select('id').eq('id', id).maybeSingle()
    if (existing.error) throw existing.error
    if (!existing.data) return res.status(404).json({ ok: false, message: 'Binance credit action was not found' })
    const edits = await loadEdits(id, readPage(req.query.page))
    return res.status(200).json({ ok: true, ...edits })
  } catch (error) {
    return fail(res, error, 'action_edits')
  }
}

export async function confirmAdminBinanceReceiptCredit(req, res) {
  const admin = authorize(req, res)
  if (!admin) return
  const transactionId = String(req.body?.transaction_id || '').trim()
  const userId = String(req.body?.user_id || '').trim()
  const amount = req.body?.verified_amount_usdt
  const amountString = typeof amount === 'number' || typeof amount === 'string' ? String(amount).trim() : ''
  const diamonds = readDiamonds(req.body?.diamonds)
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''
  if (!TRANSACTION_RE.test(transactionId)) return bad(res, 'Select a valid recorded Binance transaction')
  if (!UUID_RE.test(userId)) return bad(res, 'Select a valid Shadow recipient account')
  if (!USDT_RE.test(amountString) || Number(amountString) < 1 || Number(amountString) > 100000) {
    return bad(res, 'Verified USDT amount must be between 1 and 100000 with at most 8 decimals')
  }
  if (!Number.isSafeInteger(diamonds) || diamonds < 1 || diamonds > 10000) {
    return bad(res, 'Diamonds must be between 1 and 10000')
  }
  if (reason.length < 12 || reason.length > 500) return bad(res, 'Enter a reason between 12 and 500 characters')
  if (req.body?.binance_verified !== true || req.body?.confirm_recipient !== true) {
    return bad(res, 'Confirm the official Binance receipt and correct recipient')
  }
  try {
    if (!(await requirePasskey(req, res, 'binance_receipt_credit:' + transactionId))) return
    const { data, error } = await supabase.rpc('admin_binance_usdt_credit_apply_v1', {
      p_action: 'recovery',
      p_user_id: userId,
      p_transaction_id: transactionId,
      p_reference: transactionId,
      p_verified_usdt: amountString,
      p_diamonds: diamonds,
      p_admin_id: admin.id,
      p_admin_email: admin.email,
      p_note: reason,
      p_binance_verified: true,
      p_recipient_verified: true,
    })
    if (error) return fail(res, error, 'receipt_credit')
    return res.status(200).json({ ok: true, result: data, voucher_bonus: 100 })
  } catch (error) {
    return fail(res, error, 'receipt_credit')
  }
}

export async function confirmAdminBinanceManualTopUp(req, res) {
  const admin = authorize(req, res)
  if (!admin) return
  const userId = String(req.body?.user_id || '').trim()
  const reference = String(req.body?.reference || '').trim().toUpperCase()
  const diamonds = readDiamonds(req.body?.diamonds)
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''
  if (!UUID_RE.test(userId)) return bad(res, 'Select a valid Shadow recipient account')
  if (!TOPUP_REFERENCE_RE.test(reference)) return bad(res, 'Reference must contain 6 to 100 allowed characters')
  if (!Number.isSafeInteger(diamonds) || diamonds < 1 || diamonds > 10000) {
    return bad(res, 'Diamonds must be between 1 and 10000')
  }
  if (reason.length < 12 || reason.length > 500) return bad(res, 'Enter a reason between 12 and 500 characters')
  if (req.body?.confirmed !== true) return bad(res, 'Confirm recipient and reason for the manual adjustment')
  try {
    if (!(await requirePasskey(req, res, 'binance_manual_topup:' + userId + ':' + reference))) return
    const { data, error } = await supabase.rpc('admin_binance_usdt_credit_apply_v1', {
      p_action: 'topup',
      p_user_id: userId,
      p_transaction_id: null,
      p_reference: reference,
      p_verified_usdt: null,
      p_diamonds: diamonds,
      p_admin_id: admin.id,
      p_admin_email: admin.email,
      p_note: reason,
      p_binance_verified: false,
      p_recipient_verified: true,
    })
    if (error) return fail(res, error, 'manual_topup')
    return res.status(200).json({ ok: true, result: data, voucher_bonus: 0 })
  } catch (error) {
    return fail(res, error, 'manual_topup')
  }
}

export async function updateAdminBinanceCreditActionMetadata(req, res) {
  const admin = authorize(req, res)
  if (!admin) return
  const id = readId(req, res)
  if (!id) return
  const reference = req.body?.reference == null ? null : req.body.reference
  const mark = req.body?.mark_note == null ? null : req.body.mark_note
  const count = req.body?.expected_edit_count
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''
  if (reference === null && mark === null) return bad(res, 'Provide a display reference or mark to edit')
  if (reference !== null && (typeof reference !== 'string' || !DISPLAY_REFERENCE_RE.test(reference.trim().toUpperCase()))) {
    return bad(res, 'Invalid display reference (1-128 allowed characters)')
  }
  if (mark !== null && (typeof mark !== 'string' || mark.trim().length > 300)) {
    return bad(res, 'Mark note must contain at most 300 characters')
  }
  if (!Number.isSafeInteger(count) || count < 0) return bad(res, 'Current edit version is required')
  if (reason.length < 12 || reason.length > 500) return bad(res, 'Explain the edit in 12 to 500 characters')
  try {
    if (!(await requirePasskey(req, res, 'binance_credit_metadata_edit:' + id))) return
    const { data, error } = await supabase.rpc('admin_binance_usdt_credit_edit_v1', {
      p_action_id: id,
      p_new_reference: reference === null ? null : reference.trim().toUpperCase(),
      p_new_mark: mark === null ? null : mark.trim(),
      p_expected_edit_count: count,
      p_reason: reason,
      p_admin_id: admin.id,
      p_admin_email: admin.email,
    })
    if (error) return fail(res, error, 'metadata_edit')
    return res.status(200).json({ ok: true, result: data })
  } catch (error) {
    return fail(res, error, 'metadata_edit')
  }
}
