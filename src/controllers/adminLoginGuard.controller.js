import { isIP } from 'node:net'
import { supabase } from '../config/supabase.js'
import { writeAdminGuardEventFromController } from '../services/adminGuard.service.js'

function toPositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.min(parsed, max)
}

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function cleanSearch(value) {
  return cleanText(value, 120).replace(/[%_,()]/g, ' ')
}

function getAdminName(req) {
  return String(
    req.admin?.name
    || req.admin?.username
    || req.admin?.email
    || req.admin?.admin_id
    || req.admin?.id
    || 'Admin'
  ).slice(0, 160)
}

function isFuture(value) {
  return Boolean(value && new Date(value).getTime() > Date.now())
}

function resolveStatus(row) {
  if (row.is_permanent_blocked) return 'permanent_block'
  if (isFuture(row.blocked_until)) return row.block_status || 'temporary_block'
  return 'allowed'
}

function formatState(row) {
  return {
    id: row.id,
    guard_key: row.guard_key || '',
    ip_address: row.ip_address || '',
    device_id: row.device_id || '',
    attempted_email: row.attempted_email || '',
    admin_id: row.admin_id || '',
    admin_email: row.admin_email || '',
    user_agent: row.user_agent || '',
    failed_count: Number(row.failed_count || 0),
    success_count: Number(row.success_count || 0),
    block_level: Number(row.block_level || 0),
    block_status: resolveStatus(row),
    block_type: row.block_type || '',
    blocked_until: row.blocked_until,
    is_blocked: row.is_permanent_blocked || isFuture(row.blocked_until),
    is_permanent_blocked: Boolean(row.is_permanent_blocked),
    permanent_blocked_at: row.permanent_blocked_at,
    permanent_blocked_by: row.permanent_blocked_by || '',
    permanent_block_reason: row.permanent_block_reason || '',
    permanent_unblocked_at: row.permanent_unblocked_at,
    permanent_unblocked_by: row.permanent_unblocked_by || '',
    permanent_unblock_reason: row.permanent_unblock_reason || '',
    last_attempt_status: row.last_attempt_status || '',
    last_reason: row.last_reason || '',
    first_seen_at: row.first_seen_at,
    last_attempt_at: row.last_attempt_at,
    last_failed_at: row.last_failed_at,
    last_success_at: row.last_success_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function formatEvent(row) {
  return {
    id: row.id,
    state_id: row.state_id,
    guard_key: row.guard_key || '',
    ip_address: row.ip_address || '',
    device_id: row.device_id || '',
    trusted_device_id: row.trusted_device_id,
    attempted_email: row.attempted_email || '',
    admin_id: row.admin_id || '',
    admin_email: row.admin_email || '',
    user_agent: row.user_agent || '',
    action: row.action || '',
    result: row.result || '',
    reason: row.reason || '',
    failed_count: Number(row.failed_count || 0),
    block_level: Number(row.block_level || 0),
    block_status: row.block_status || 'allowed',
    blocked_until: row.blocked_until,
    is_trusted_device: Boolean(row.is_trusted_device),
    metadata: row.metadata || {},
    occurred_at: row.occurred_at,
    created_at: row.created_at,
  }
}

function formatTrustedDevice(row) {
  return {
    id: row.id,
    admin_id: row.admin_id || '',
    admin_email: row.admin_email || '',
    device_id: row.device_id || '',
    device_label: row.device_label || '',
    ip_address: row.ip_address || '',
    user_agent: row.user_agent || '',
    is_active: Boolean(row.is_active),
    trusted_at: row.trusted_at,
    last_seen_at: row.last_seen_at,
    revoked_at: row.revoked_at,
    revoked_by: row.revoked_by || '',
    revoked_reason: row.revoked_reason || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function formatTrustedIp(row) {
  return {
    id: row.id,
    ip_address: row.ip_address || '',
    label: row.label || '',
    admin_id: row.admin_id || '',
    admin_email: row.admin_email || '',
    is_active: Boolean(row.is_active),
    trusted_at: row.trusted_at,
    last_seen_at: row.last_seen_at,
    revoked_at: row.revoked_at,
    revoked_by: row.revoked_by || '',
    revoked_reason: row.revoked_reason || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

async function countRows(table, applyFilters = (query) => query) {
  let query = supabase.from(table).select('id', { count: 'exact', head: true })
  query = applyFilters(query)
  const { count, error } = await query
  if (error) throw error
  return count || 0
}

async function getStateById(stateId) {
  if (!/^[0-9a-f-]{36}$/i.test(stateId)) {
    return { errorResponse: { status: 400, message: 'Invalid admin guard state ID' } }
  }

  const { data, error } = await supabase
    .from('admin_guard_state')
    .select('*')
    .eq('id', stateId)
    .maybeSingle()

  if (error) throw error

  if (!data) {
    return { errorResponse: { status: 404, message: 'Admin guard state not found' } }
  }

  return { data }
}

export async function getAdminGuardOverview(req, res) {
  try {
    const now = new Date().toISOString()
    const dayStart = new Date()
    dayStart.setHours(0, 0, 0, 0)

    const [
      totalTracked,
      activeBlocks,
      permanentBlocks,
      failedToday,
      successToday,
      trustedDevices,
      trustedIps,
    ] = await Promise.all([
      countRows('admin_guard_state'),
      countRows('admin_guard_state', (query) => query.gt('blocked_until', now)),
      countRows('admin_guard_state', (query) => query.eq('is_permanent_blocked', true)),
      countRows('admin_login_events', (query) => query.eq('result', 'failed').gte('occurred_at', dayStart.toISOString())),
      countRows('admin_login_events', (query) => query.eq('result', 'success').gte('occurred_at', dayStart.toISOString())),
      countRows('admin_trusted_devices', (query) => query.eq('is_active', true)),
      countRows('admin_trusted_ips', (query) => query.eq('is_active', true)),
    ])

    return res.status(200).json({
      ok: true,
      summary: {
        total_tracked: totalTracked,
        active_blocks: activeBlocks,
        permanent_blocks: permanentBlocks,
        failed_today: failedToday,
        success_today: successToday,
        trusted_devices: trustedDevices,
        trusted_ips: trustedIps,
      },
    })
  } catch (error) {
    console.error('ADMIN GUARD OVERVIEW ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load admin guard overview',
      error: error.message,
    })
  }
}

export async function getAdminGuardStates(req, res) {
  try {
    const page = toPositiveInt(req.query.page, 1, 100000)
    const limit = toPositiveInt(req.query.limit, 20, 100)
    const filter = String(req.query.filter || 'all').trim().toLowerCase()
    const q = cleanSearch(req.query.q)
    const from = (page - 1) * limit
    const to = from + limit - 1
    const now = new Date().toISOString()

    let query = supabase
      .from('admin_guard_state')
      .select('*', { count: 'exact' })
      .order('updated_at', { ascending: false })
      .range(from, to)

    if (filter === 'blocked') {
      query = query.or(`blocked_until.gt.${now},is_permanent_blocked.eq.true`)
    } else if (filter === 'permanent') {
      query = query.eq('is_permanent_blocked', true)
    } else if (filter === 'failed') {
      query = query.gt('failed_count', 0)
    } else if (filter === 'success') {
      query = query.eq('last_attempt_status', 'success')
    } else if (filter === 'allowed') {
      query = query.eq('is_permanent_blocked', false).or(`blocked_until.is.null,blocked_until.lte.${now}`)
    }

    if (q) {
      if (isIP(q)) {
        query = query.eq('ip_address', q)
      } else {
        query = query.or(
          `guard_key.ilike.%${q}%,device_id.ilike.%${q}%,attempted_email.ilike.%${q}%,admin_email.ilike.%${q}%,user_agent.ilike.%${q}%,last_reason.ilike.%${q}%`
        )
      }
    }

    const { data, error, count } = await query

    if (error) throw error

    const total = count || 0
    const totalPages = Math.max(1, Math.ceil(total / limit))

    return res.status(200).json({
      ok: true,
      states: (data || []).map(formatState),
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
    })
  } catch (error) {
    console.error('ADMIN GUARD STATES ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load admin guard states',
      error: error.message,
    })
  }
}

export async function getAdminGuardEvents(req, res) {
  try {
    const page = toPositiveInt(req.query.page, 1, 100000)
    const limit = toPositiveInt(req.query.limit, 20, 100)
    const action = String(req.query.action || '').trim().toLowerCase()
    const result = String(req.query.result || '').trim().toLowerCase()
    const q = cleanSearch(req.query.q)
    const from = (page - 1) * limit
    const to = from + limit - 1

    let query = supabase
      .from('admin_login_events')
      .select('*', { count: 'exact' })
      .order('occurred_at', { ascending: false })
      .range(from, to)

    if (action) query = query.eq('action', action)
    if (result) query = query.eq('result', result)

    if (q) {
      if (isIP(q)) {
        query = query.eq('ip_address', q)
      } else {
        query = query.or(
          `guard_key.ilike.%${q}%,device_id.ilike.%${q}%,attempted_email.ilike.%${q}%,admin_email.ilike.%${q}%,user_agent.ilike.%${q}%,action.ilike.%${q}%,result.ilike.%${q}%,reason.ilike.%${q}%`
        )
      }
    }

    const { data, error, count } = await query

    if (error) throw error

    const total = count || 0
    const totalPages = Math.max(1, Math.ceil(total / limit))

    return res.status(200).json({
      ok: true,
      events: (data || []).map(formatEvent),
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
    })
  } catch (error) {
    console.error('ADMIN GUARD EVENTS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load admin guard events',
      error: error.message,
    })
  }
}

export async function releaseAdminGuardBlock(req, res) {
  try {
    const stateId = String(req.params.stateId || '').trim()
    const { data: existing, errorResponse } = await getStateById(stateId)

    if (errorResponse) {
      return res.status(errorResponse.status).json({
        ok: false,
        message: errorResponse.message,
      })
    }

    if (existing.is_permanent_blocked) {
      return res.status(400).json({
        ok: false,
        message: 'Permanent block must be unblocked separately',
      })
    }

    const now = new Date().toISOString()
    const adminName = getAdminName(req)

    const { data: updated, error } = await supabase
      .from('admin_guard_state')
      .update({
        failed_count: 0,
        block_status: 'allowed',
        block_type: '',
        blocked_until: null,
        last_attempt_status: 'released',
        last_reason: `Admin login block released by ${adminName}`,
        updated_at: now,
      })
      .eq('id', existing.id)
      .select()
      .single()

    if (error) throw error

    await writeAdminGuardEventFromController(existing, {
      action: 'block_released',
      result: 'released',
      reason: `Admin login block released by ${adminName}`,
      failed_count: Number(existing.failed_count || 0),
      block_level: Number(existing.block_level || 0),
      block_status: 'allowed',
      blocked_until: null,
      metadata: {
        released_by: adminName,
        previous_blocked_until: existing.blocked_until,
      },
    })

    return res.status(200).json({
      ok: true,
      message: 'Admin login block released',
      state: formatState(updated),
    })
  } catch (error) {
    console.error('ADMIN GUARD RELEASE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to release admin login block',
      error: error.message,
    })
  }
}

export async function permanentBlockAdminGuard(req, res) {
  try {
    const stateId = String(req.params.stateId || '').trim()
    const reason = cleanText(req.body?.reason || req.body?.note || '', 500)

    if (reason.length < 3) {
      return res.status(400).json({
        ok: false,
        message: 'Permanent block reason is required',
      })
    }

    const { data: existing, errorResponse } = await getStateById(stateId)

    if (errorResponse) {
      return res.status(errorResponse.status).json({
        ok: false,
        message: errorResponse.message,
      })
    }

    const now = new Date().toISOString()
    const adminName = getAdminName(req)

    const { data: updated, error } = await supabase
      .from('admin_guard_state')
      .update({
        is_permanent_blocked: true,
        permanent_blocked_at: now,
        permanent_blocked_by: adminName,
        permanent_block_reason: reason,
        block_status: 'permanent_block',
        block_type: 'permanent',
        blocked_until: null,
        last_attempt_status: 'permanent_blocked',
        last_reason: `Permanently blocked by ${adminName}`,
        updated_at: now,
      })
      .eq('id', existing.id)
      .select()
      .single()

    if (error) throw error

    await writeAdminGuardEventFromController(existing, {
      action: 'permanent_blocked',
      result: 'blocked',
      reason,
      failed_count: Number(existing.failed_count || 0),
      block_level: Number(existing.block_level || 0),
      block_status: 'permanent_block',
      blocked_until: null,
      metadata: {
        blocked_by: adminName,
        previous_block_status: existing.block_status || '',
        previous_blocked_until: existing.blocked_until,
      },
    })

    return res.status(200).json({
      ok: true,
      message: 'Admin login identity permanently blocked',
      state: formatState(updated),
    })
  } catch (error) {
    console.error('ADMIN GUARD PERMANENT BLOCK ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to permanently block admin login identity',
      error: error.message,
    })
  }
}

export async function unblockAdminGuardPermanent(req, res) {
  try {
    const stateId = String(req.params.stateId || '').trim()
    const reason = cleanText(req.body?.reason || req.body?.note || 'Manual unblock', 500)
    const { data: existing, errorResponse } = await getStateById(stateId)

    if (errorResponse) {
      return res.status(errorResponse.status).json({
        ok: false,
        message: errorResponse.message,
      })
    }

    const now = new Date().toISOString()
    const adminName = getAdminName(req)

    const { data: updated, error } = await supabase
      .from('admin_guard_state')
      .update({
        is_permanent_blocked: false,
        permanent_unblocked_at: now,
        permanent_unblocked_by: adminName,
        permanent_unblock_reason: reason,
        failed_count: 0,
        block_status: 'allowed',
        block_type: '',
        blocked_until: null,
        last_attempt_status: 'permanent_unblocked',
        last_reason: `Permanent block removed by ${adminName}`,
        updated_at: now,
      })
      .eq('id', existing.id)
      .select()
      .single()

    if (error) throw error

    await writeAdminGuardEventFromController(existing, {
      action: 'permanent_unblocked',
      result: 'released',
      reason,
      failed_count: Number(existing.failed_count || 0),
      block_level: Number(existing.block_level || 0),
      block_status: 'allowed',
      blocked_until: null,
      metadata: {
        unblocked_by: adminName,
        previous_permanent_blocked_at: existing.permanent_blocked_at,
        previous_permanent_block_reason: existing.permanent_block_reason,
      },
    })

    return res.status(200).json({
      ok: true,
      message: 'Admin login permanent block removed',
      state: formatState(updated),
    })
  } catch (error) {
    console.error('ADMIN GUARD PERMANENT UNBLOCK ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to unblock admin login identity',
      error: error.message,
    })
  }
}

export async function getAdminTrustedDevices(req, res) {
  try {
    const page = toPositiveInt(req.query.page, 1, 100000)
    const limit = toPositiveInt(req.query.limit, 20, 100)
    const filter = String(req.query.filter || 'active').trim().toLowerCase()
    const from = (page - 1) * limit
    const to = from + limit - 1

    let query = supabase
      .from('admin_trusted_devices')
      .select('*', { count: 'exact' })
      .order('updated_at', { ascending: false })
      .range(from, to)

    if (filter === 'active') query = query.eq('is_active', true)
    if (filter === 'revoked') query = query.eq('is_active', false)

    const { data, error, count } = await query

    if (error) throw error

    const total = count || 0
    const totalPages = Math.max(1, Math.ceil(total / limit))

    return res.status(200).json({
      ok: true,
      devices: (data || []).map(formatTrustedDevice),
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1,
    })
  } catch (error) {
    console.error('ADMIN TRUSTED DEVICES ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load trusted devices',
      error: error.message,
    })
  }
}

export async function revokeAdminTrustedDevice(req, res) {
  try {
    const deviceId = String(req.params.deviceId || '').trim()
    const reason = cleanText(req.body?.reason || req.body?.note || 'Manual revoke', 500)

    if (!/^[0-9a-f-]{36}$/i.test(deviceId)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid trusted device ID',
      })
    }

    const now = new Date().toISOString()
    const adminName = getAdminName(req)

    const { data, error } = await supabase
      .from('admin_trusted_devices')
      .update({
        is_active: false,
        revoked_at: now,
        revoked_by: adminName,
        revoked_reason: reason,
        updated_at: now,
      })
      .eq('id', deviceId)
      .select()
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: 'Trusted device revoked',
      device: formatTrustedDevice(data),
    })
  } catch (error) {
    console.error('ADMIN TRUSTED DEVICE REVOKE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to revoke trusted device',
      error: error.message,
    })
  }
}

export async function getAdminTrustedIps(req, res) {
  try {
    const { data, error } = await supabase
      .from('admin_trusted_ips')
      .select('*')
      .order('updated_at', { ascending: false })

    if (error) throw error

    return res.status(200).json({
      ok: true,
      ips: (data || []).map(formatTrustedIp),
    })
  } catch (error) {
    console.error('ADMIN TRUSTED IPS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load trusted IPs',
      error: error.message,
    })
  }
}

export async function addAdminTrustedIp(req, res) {
  try {
    const ipAddress = cleanText(req.body?.ip_address || req.body?.ip || '', 150)
    const label = cleanText(req.body?.label || 'Trusted admin IP', 160)

    if (!isIP(ipAddress)) {
      return res.status(400).json({
        ok: false,
        message: 'Valid IP address is required',
      })
    }

    const now = new Date().toISOString()
    const adminName = getAdminName(req)

    const { data, error } = await supabase
      .from('admin_trusted_ips')
      .upsert({
        ip_address: ipAddress,
        label,
        admin_id: req.admin?.admin_id || req.admin?.id || '',
        admin_email: req.admin?.email || '',
        is_active: true,
        trusted_at: now,
        revoked_at: null,
        revoked_by: '',
        revoked_reason: '',
        updated_at: now,
      }, { onConflict: 'ip_address' })
      .select()
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: `Trusted IP saved by ${adminName}`,
      ip: formatTrustedIp(data),
    })
  } catch (error) {
    console.error('ADMIN TRUSTED IP ADD ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to save trusted IP',
      error: error.message,
    })
  }
}

export async function revokeAdminTrustedIp(req, res) {
  try {
    const ipId = String(req.params.ipId || '').trim()
    const reason = cleanText(req.body?.reason || req.body?.note || 'Manual revoke', 500)

    if (!/^[0-9a-f-]{36}$/i.test(ipId)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid trusted IP ID',
      })
    }

    const now = new Date().toISOString()
    const adminName = getAdminName(req)

    const { data, error } = await supabase
      .from('admin_trusted_ips')
      .update({
        is_active: false,
        revoked_at: now,
        revoked_by: adminName,
        revoked_reason: reason,
        updated_at: now,
      })
      .eq('id', ipId)
      .select()
      .single()

    if (error) throw error

    return res.status(200).json({
      ok: true,
      message: `Trusted IP revoked by ${adminName}`,
      ip: formatTrustedIp(data),
    })
  } catch (error) {
    console.error('ADMIN TRUSTED IP REVOKE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to revoke trusted IP',
      error: error.message,
    })
  }
}
