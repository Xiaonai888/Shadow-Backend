import { supabase } from '../config/supabase.js'
import { verifyAdminPasskeyPin } from '../services/adminPasskeyPin.service.js'

const HISTORY_LIMIT = 10
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REFERENCE_RE = /^[A-Z0-9][A-Z0-9._/-]{5,99}$/

const ACTION_FIELDS = 'id,action_type,payment_id,user_id,reference,diamonds,amount_usd,bank_paid_at,balance_before,balance_after,admin_id,admin_email,reason,created_at'
const METADATA_FIELDS = 'action_id,display_reference,mark_note,edit_count,updated_by_id,updated_by_email,updated_at'
const EDIT_FIELDS = 'id,action_id,old_reference,new_reference,old_mark,new_mark,edit_number,reason,admin_id,admin_email,created_at'

function adminIdentity(req) {
  const role = String(req.admin?.role || '').trim().toLowerCase()
  const id = String(req.admin?.admin_id || req.admin?.id || req.admin?.email || '').trim()
  const email = String(req.admin?.email || '').trim().toLowerCase()
  return { permitted: ['owner', 'admin'].includes(role), id, email }
}

function authorize(req, res) {
  const admin = adminIdentity(req)
  if (!admin.permitted || !admin.id || !admin.email) {
    res.status(403).json({ ok: false, message: 'Owner/Admin account with an email is required' })
    return null
  }
  return admin
}

function readActionId(req, res) {
  const actionId = String(req.params.actionId || '').trim()
  if (!UUID_RE.test(actionId)) {
    res.status(400).json({ ok: false, message: 'Invalid payment action ID' })
    return null
  }
  return actionId
}

function fail(res, error, fallback) {
  console.error('ADMIN PAYMENT ACTION HISTORY ERROR:', error)
  return res.status(500).json({ ok: false, message: fallback })
}

function readPage(value) {
  return Math.min(Math.max(Number.parseInt(value, 10) || 1, 1), 100000)
}

async function loadEdits(actionId, page) {
  const start = (page - 1) * HISTORY_LIMIT
  const { data, error } = await supabase
    .from('admin_payment_recovery_action_edits')
    .select(EDIT_FIELDS)
    .eq('action_id', actionId)
    .order('edit_number', { ascending: false })
    .range(start, start + HISTORY_LIMIT)
  if (error) throw error
  const rows = data || []
  return {
    items: rows.slice(0, HISTORY_LIMIT),
    page,
    limit: HISTORY_LIMIT,
    has_next: rows.length > HISTORY_LIMIT,
    has_prev: page > 1,
  }
}

export async function getAdminPaymentHistoryMetadata(req, res) {
  if (!authorize(req, res)) return
  const ids = String(req.query.ids || '').split(',').map((id) => id.trim()).filter(Boolean)
  if (!ids.length || ids.length > HISTORY_LIMIT || new Set(ids).size !== ids.length || !ids.every((id) => UUID_RE.test(id))) {
    return res.status(400).json({ ok: false, message: 'Provide 1 to 10 unique payment action IDs' })
  }
  try {
    const { data, error } = await supabase
      .from('admin_payment_recovery_action_metadata')
      .select(METADATA_FIELDS)
      .in('action_id', ids)
      .limit(HISTORY_LIMIT)
    if (error) throw error
    res.set('Cache-Control', 'no-store')
    return res.status(200).json({ ok: true, items: data || [] })
  } catch (error) {
    return fail(res, error, 'Unable to load payment history edit marks')
  }
}

export async function getAdminPaymentActionDetails(req, res) {
  if (!authorize(req, res)) return
  const actionId = readActionId(req, res)
  if (!actionId) return
  try {
    const result = await supabase
      .from('admin_payment_recovery_actions')
      .select(ACTION_FIELDS)
      .eq('id', actionId)
      .maybeSingle()
    if (result.error) throw result.error
    if (!result.data) return res.status(404).json({ ok: false, message: 'Payment action not found' })

    const [metadataResult, editsResult, userResult] = await Promise.all([
      supabase
        .from('admin_payment_recovery_action_metadata')
        .select(METADATA_FIELDS)
        .eq('action_id', actionId)
        .maybeSingle(),
      loadEdits(actionId, 1),
      supabase
        .from('users')
        .select('id,name,username')
        .eq('id', result.data.user_id)
        .maybeSingle(),
    ])
    if (metadataResult.error) throw metadataResult.error
    if (userResult.error) throw userResult.error

    const metadata = metadataResult.data
    res.set('Cache-Control', 'no-store')
    return res.status(200).json({
      ok: true,
      action: {
        ...result.data,
        user_name: userResult.data?.name || userResult.data?.username || null,
        display_reference: metadata?.display_reference || result.data.reference,
        mark_note: metadata?.mark_note || '',
        edit_count: Number(metadata?.edit_count || 0),
        updated_at: metadata?.updated_at || null,
        updated_by_email: metadata?.updated_by_email || null,
      },
      edits: editsResult,
    })
  } catch (error) {
    return fail(res, error, 'Unable to load payment action details')
  }
}

export async function getAdminPaymentActionEdits(req, res) {
  if (!authorize(req, res)) return
  const actionId = readActionId(req, res)
  if (!actionId) return
  const page = readPage(req.query.page)
  try {
    const existing = await supabase
      .from('admin_payment_recovery_actions')
      .select('id')
      .eq('id', actionId)
      .maybeSingle()
    if (existing.error) throw existing.error
    if (!existing.data) return res.status(404).json({ ok: false, message: 'Payment action not found' })
    const edits = await loadEdits(actionId, page)
    res.set('Cache-Control', 'no-store')
    return res.status(200).json({ ok: true, ...edits })
  } catch (error) {
    return fail(res, error, 'Unable to load payment action edit history')
  }
}

export async function updateAdminPaymentActionMetadata(req, res) {
  const admin = authorize(req, res)
  if (!admin) return
  const actionId = readActionId(req, res)
  if (!actionId) return

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
  const reference = body.reference == null ? null : body.reference
  const mark = body.mark_note == null ? null : body.mark_note
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  const pin = typeof body.passkey === 'string' ? body.passkey.trim() : ''
  const expectedEditCount = body.expected_edit_count

  if (reference === null && mark === null) {
    return res.status(400).json({ ok: false, message: 'Provide a reference or a mark note to edit' })
  }
  if (reference !== null && (typeof reference !== 'string' || !REFERENCE_RE.test(reference.trim().toUpperCase()))) {
    return res.status(400).json({ ok: false, message: 'Reference must contain 6 to 100 allowed characters' })
  }
  if (mark !== null && (typeof mark !== 'string' || mark.trim().length > 300)) {
    return res.status(400).json({ ok: false, message: 'Mark note must contain at most 300 characters' })
  }
  if (!Number.isSafeInteger(expectedEditCount) || expectedEditCount < 0) {
    return res.status(400).json({ ok: false, message: 'Current edit version is required' })
  }
  if (reason.length < 12 || reason.length > 500) {
    return res.status(400).json({ ok: false, message: 'Explain the edit in 12 to 500 characters' })
  }
  if (!/^\d{6}$/.test(pin)) {
    return res.status(400).json({ ok: false, message: 'Enter the six-digit Admin Passkey' })
  }

  try {
    const verified = await verifyAdminPasskeyPin({
      admin: req.admin,
      req,
      pin,
      purpose: 'payment_action_metadata_edit:' + actionId,
    })
    if (!verified.ok) {
      return res.status(verified.status || 403).json({
        ok: false,
        code: verified.code || 'PASSKEY_VERIFICATION_FAILED',
        message: verified.message || 'Admin Passkey verification failed',
      })
    }

    const { data, error } = await supabase.rpc('admin_payment_recovery_edit_metadata_v1', {
      p_action_id: actionId,
      p_new_reference: reference === null ? null : reference.trim().toUpperCase(),
      p_new_mark: mark === null ? null : mark.trim(),
      p_expected_edit_count: expectedEditCount,
      p_reason: reason,
      p_admin_id: admin.id,
      p_admin_email: admin.email,
    })
    if (error) {
      const message = String(error.message || '')
      if (error.code === 'P0001') {
        if (message.includes('was not found')) return res.status(404).json({ ok: false, message: 'Payment action not found' })
        if (message.includes('another admin')) return res.status(409).json({ ok: false, message: 'Another admin updated this action. Refresh and retry' })
        if (message.includes('already assigned')) return res.status(409).json({ ok: false, message: 'Reference is already used by another payment' })
        if (message.includes('No information was changed')) return res.status(409).json({ ok: false, message: 'No information was changed' })
        if (message.includes('must contain') || message.includes('is required')) return res.status(400).json({ ok: false, message: 'Invalid edit information' })
      }
      return fail(res, error, 'Unable to save payment action edit')
    }

    res.set('Cache-Control', 'no-store')
    return res.status(200).json({ ok: true, result: data })
  } catch (error) {
    return fail(res, error, 'Unable to save payment action edit')
  }
}
