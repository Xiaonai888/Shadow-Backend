import { isIP } from 'node:net'
import { supabase } from '../config/supabase.js'

function toPositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.min(parsed, max)
}

function cleanSearch(value) {
  return String(value || '')
    .trim()
    .replace(/[%_,()]/g, ' ')
    .slice(0, 120)
}

function cleanReason(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function isFuture(value) {
  return Boolean(value && new Date(value).getTime() > Date.now())
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

function resolveStateStatus(row) {
  if (row.is_permanent_blocked) return 'permanent_block'
  if (isFuture(row.quarantine_until)) return 'seven_day_quarantine'
  if (isFuture(row.cooldown_until)) return 'temporary_cooldown'
  return row.block_status === 'permanent_block' || row.block_status === 'seven_day_quarantine' || row.block_status === 'temporary_cooldown'
    ? 'allowed'
    : row.block_status || 'allowed'
}

function formatState(row) {
  const blockStatus = resolveStateStatus(row)

  return {
    id: row.id,
    guard_key: row.guard_key || '',
    scope: row.scope || 'global',
    ip_address: row.ip_address || '',
    visitor_id: row.visitor_id || '',
    account_id: row.account_id || '',
    request_count: Number(row.request_count || 0),
    offense_count: Number(row.offense_count || 0),
    spam_score: Number(row.spam_score || 0),
    cooldown_until: row.cooldown_until,
    quarantine_until: row.quarantine_until,
    quarantine_started_at: row.quarantine_started_at,
    quarantine_reason: row.quarantine_reason || '',
    block_status: blockStatus,
    block_reason: row.block_reason || '',
    is_in_cooldown: blockStatus === 'temporary_cooldown',
    is_in_quarantine: blockStatus === 'seven_day_quarantine',
    is_permanent_blocked: blockStatus === 'permanent_block',
    permanent_blocked_at: row.permanent_blocked_at,
    permanent_blocked_by: row.permanent_blocked_by || '',
    permanent_block_reason: row.permanent_block_reason || '',
    permanent_unblocked_at: row.permanent_unblocked_at,
    permanent_unblocked_by: row.permanent_unblocked_by || '',
    permanent_unblock_reason: row.permanent_unblock_reason || '',
    last_reason: row.last_reason || '',
    last_endpoint: row.last_endpoint || '',
    last_method: row.last_method || '',
    window_started_at: row.window_started_at,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    last_offense_at: row.last_offense_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function formatEvent(row) {
  return {
    id: row.id,
    state_id: row.state_id,
    guard_key: row.guard_key || '',
    scope: row.scope || 'global',
    ip_address: row.ip_address || '',
    visitor_id: row.visitor_id || '',
    account_id: row.account_id || '',
    endpoint: row.endpoint || '',
    method: row.method || '',
    action: row.action || '',
    reason: row.reason || '',
    request_count: Number(row.request_count || 0),
    window_seconds: Number(row.window_seconds || 0),
    offense_count: Number(row.offense_count || 0),
    spam_score: Number(row.spam_score || 0),
    cooldown_until: row.cooldown_until,
    block_status: row.block_status || '',
    block_until: row.block_until,
    admin_note: row.admin_note || '',
    metadata: row.metadata || {},
    occurred_at: row.occurred_at,
    created_at: row.created_at,
  }
}

async function countRows(table, applyFilters = (query) => query) {
  let query = supabase
    .from(table)
    .select('id', {
      count: 'exact',
      head: true,
    })

  query = applyFilters(query)

  const { count, error } = await query

  if (error) throw error
  return count || 0
}

async function getSpamGuardStateById(stateId) {
  if (!/^[0-9a-f-]{36}$/i.test(stateId)) {
    return { errorResponse: { status: 400, message: 'Invalid spam guard state ID' } }
  }

  const { data, error } = await supabase
    .from('spam_guard_state')
    .select('*')
    .eq('id', stateId)
    .maybeSingle()

  if (error) throw error

  if (!data) {
    return { errorResponse: { status: 404, message: 'Spam guard state not found' } }
  }

  return { data }
}

async function insertSpamGuardEvent(existing, payload) {
  const now = payload.now || new Date().toISOString()

  const { error } = await supabase
    .from('spam_guard_events')
    .insert({
      state_id: existing.id,
      guard_key: existing.guard_key,
      scope: existing.scope,
      ip_address: existing.ip_address,
      visitor_id: existing.visitor_id,
      account_id: existing.account_id,
      endpoint: existing.last_endpoint || '',
      method: existing.last_method || '',
      action: payload.action,
      reason: payload.reason || '',
      request_count: Number(existing.request_count || 0),
      window_seconds: 0,
      offense_count: Number(existing.offense_count || 0),
      spam_score: Number(existing.spam_score || 0),
      cooldown_until: payload.cooldown_until || null,
      block_status: payload.block_status || 'allowed',
      block_until: payload.block_until || null,
      admin_note: payload.admin_note || '',
      metadata: payload.metadata || {},
      occurred_at: now,
      created_at: now,
    })

  if (error) throw error
}

export async function getAdminSpamGuardOverview(req, res) {
  try {
    const now = new Date().toISOString()
    const dayStart = new Date()
    dayStart.setHours(0, 0, 0, 0)

    const [
      totalTracked,
      activeCooldowns,
      activeQuarantines,
      permanentBlocks,
      offendersToday,
      highSpamScore,
      visitorTrackingCooldowns,
      accountAccessCooldowns,
      readerActionCooldowns,
      paymentCooldowns,
    ] = await Promise.all([
      countRows('spam_guard_state'),
      countRows(
        'spam_guard_state',
        (query) => query
          .gt('cooldown_until', now)
          .eq('is_permanent_blocked', false)
      ),
      countRows(
        'spam_guard_state',
        (query) => query
          .gt('quarantine_until', now)
          .eq('is_permanent_blocked', false)
      ),
      countRows(
        'spam_guard_state',
        (query) => query.eq('is_permanent_blocked', true)
      ),
      countRows(
        'spam_guard_events',
        (query) => query
          .in('action', ['cooldown_started', 'quarantine_started', 'permanent_blocked'])
          .gte('occurred_at', dayStart.toISOString())
      ),
      countRows(
        'spam_guard_state',
        (query) => query.gte('spam_score', 90)
      ),
      countRows(
        'spam_guard_state',
        (query) => query
          .eq('scope', 'visitor_tracking')
          .gt('cooldown_until', now)
      ),
      countRows(
        'spam_guard_state',
        (query) => query
          .eq('scope', 'account_access')
          .gt('cooldown_until', now)
      ),
      countRows(
        'spam_guard_state',
        (query) => query
          .eq('scope', 'reader_actions')
          .gt('cooldown_until', now)
      ),
      countRows(
        'spam_guard_state',
        (query) => query
          .eq('scope', 'payment_actions')
          .gt('cooldown_until', now)
      ),
    ])

    return res.status(200).json({
      ok: true,
      summary: {
        total_tracked: totalTracked,
        active_cooldowns: activeCooldowns,
        active_quarantines: activeQuarantines,
        permanent_blocks: permanentBlocks,
        active_blocks: activeCooldowns + activeQuarantines + permanentBlocks,
        offenses_today: offendersToday,
        high_spam_score: highSpamScore,
        visitor_tracking_cooldowns: visitorTrackingCooldowns,
        account_access_cooldowns: accountAccessCooldowns,
        reader_action_cooldowns: readerActionCooldowns,
        payment_cooldowns: paymentCooldowns,
      },
    })
  } catch (error) {
    console.error('ADMIN SPAM GUARD OVERVIEW ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load spam guard overview',
      error: error.message,
    })
  }
}

export async function getAdminSpamGuardStates(req, res) {
  try {
    const page = toPositiveInt(req.query.page, 1, 100000)
    const limit = toPositiveInt(req.query.limit, 20, 100)
    const filter = String(req.query.filter || 'all').trim().toLowerCase()
    const scope = String(req.query.scope || '').trim().toLowerCase()
    const q = cleanSearch(req.query.q)
    const from = (page - 1) * limit
    const to = from + limit - 1
    const now = new Date().toISOString()

    let query = supabase
      .from('spam_guard_state')
      .select(
        'id, guard_key, scope, ip_address, visitor_id, account_id, window_started_at, request_count, offense_count, cooldown_until, quarantine_until, quarantine_started_at, quarantine_reason, block_status, block_reason, is_permanent_blocked, permanent_blocked_at, permanent_blocked_by, permanent_block_reason, permanent_unblocked_at, permanent_unblocked_by, permanent_unblock_reason, spam_score, last_reason, last_endpoint, last_method, first_seen_at, last_seen_at, last_offense_at, created_at, updated_at',
        { count: 'exact' }
      )
      .order('updated_at', { ascending: false })
      .range(from, to)

    if (scope) query = query.eq('scope', scope)

    if (filter === 'cooldown') {
      query = query
        .gt('cooldown_until', now)
        .eq('is_permanent_blocked', false)
    } else if (filter === 'quarantine') {
      query = query
        .gt('quarantine_until', now)
        .eq('is_permanent_blocked', false)
    } else if (filter === 'permanent') {
      query = query.eq('is_permanent_blocked', true)
    } else if (filter === 'blocked') {
      query = query.or(`cooldown_until.gt.${now},quarantine_until.gt.${now},is_permanent_blocked.eq.true`)
    } else if (filter === 'released') {
      query = query
        .eq('is_permanent_blocked', false)
        .or(`cooldown_until.is.null,cooldown_until.lte.${now}`)
        .or(`quarantine_until.is.null,quarantine_until.lte.${now}`)
    } else if (filter === 'high_score') {
      query = query.gte('spam_score', 90)
    } else if (filter === 'repeat_offender') {
      query = query.gte('offense_count', 2)
    }

    if (q) {
      if (isIP(q)) {
        query = query.eq('ip_address', q)
      } else {
        query = query.or(
          `guard_key.ilike.%${q}%,scope.ilike.%${q}%,visitor_id.ilike.%${q}%,account_id.ilike.%${q}%,last_endpoint.ilike.%${q}%,last_reason.ilike.%${q}%,block_reason.ilike.%${q}%,permanent_block_reason.ilike.%${q}%`
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
    console.error('ADMIN SPAM GUARD STATES ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load spam guard states',
      error: error.message,
    })
  }
}

export async function getAdminSpamGuardEvents(req, res) {
  try {
    const page = toPositiveInt(req.query.page, 1, 100000)
    const limit = toPositiveInt(req.query.limit, 20, 100)
    const scope = String(req.query.scope || '').trim().toLowerCase()
    const action = String(req.query.action || '').trim().toLowerCase()
    const q = cleanSearch(req.query.q)
    const from = (page - 1) * limit
    const to = from + limit - 1

    let query = supabase
      .from('spam_guard_events')
      .select(
        'id, state_id, guard_key, scope, ip_address, visitor_id, account_id, endpoint, method, action, reason, request_count, window_seconds, offense_count, spam_score, cooldown_until, block_status, block_until, admin_note, metadata, occurred_at, created_at',
        { count: 'exact' }
      )
      .order('occurred_at', { ascending: false })
      .range(from, to)

    if (scope) query = query.eq('scope', scope)
    if (action) query = query.eq('action', action)

    if (q) {
      if (isIP(q)) {
        query = query.eq('ip_address', q)
      } else {
        query = query.or(
          `guard_key.ilike.%${q}%,scope.ilike.%${q}%,visitor_id.ilike.%${q}%,account_id.ilike.%${q}%,endpoint.ilike.%${q}%,reason.ilike.%${q}%,action.ilike.%${q}%,block_status.ilike.%${q}%,admin_note.ilike.%${q}%`
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
    console.error('ADMIN SPAM GUARD EVENTS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load spam guard events',
      error: error.message,
    })
  }
}

export async function releaseAdminSpamGuardCooldown(req, res) {
  try {
    const stateId = String(req.params.stateId || '').trim()
    const { data: existing, errorResponse } = await getSpamGuardStateById(stateId)

    if (errorResponse) {
      return res.status(errorResponse.status).json({
        ok: false,
        message: errorResponse.message,
      })
    }

    const now = new Date().toISOString()
    const adminName = getAdminName(req)
    const activeQuarantine = isFuture(existing.quarantine_until)
    const nextStatus = existing.is_permanent_blocked
      ? 'permanent_block'
      : activeQuarantine
        ? 'seven_day_quarantine'
        : 'allowed'

    const { data: updated, error: updateError } = await supabase
      .from('spam_guard_state')
      .update({
        cooldown_until: null,
        request_count: 0,
        window_started_at: now,
        block_status: nextStatus,
        block_reason: nextStatus === 'allowed' ? '' : existing.block_reason || existing.quarantine_reason || existing.permanent_block_reason || '',
        last_reason: `Cooldown released manually by ${adminName}`,
        updated_at: now,
      })
      .eq('id', stateId)
      .select()
      .single()

    if (updateError) throw updateError

    await insertSpamGuardEvent(existing, {
      now,
      action: 'cooldown_released',
      reason: `Released manually by ${adminName}`,
      cooldown_until: null,
      block_status: nextStatus,
      block_until: activeQuarantine ? existing.quarantine_until : null,
      admin_note: `Released by ${adminName}`,
      metadata: {
        released_by: adminName,
        previous_cooldown_until: existing.cooldown_until,
      },
    })

    return res.status(200).json({
      ok: true,
      message: 'Temporary cooldown released',
      state: formatState(updated),
    })
  } catch (error) {
    console.error('ADMIN SPAM GUARD RELEASE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to release temporary cooldown',
      error: error.message,
    })
  }
}

export async function releaseAdminSpamGuardQuarantine(req, res) {
  try {
    const stateId = String(req.params.stateId || '').trim()
    const { data: existing, errorResponse } = await getSpamGuardStateById(stateId)

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
    const activeCooldown = isFuture(existing.cooldown_until)
    const nextStatus = activeCooldown ? 'temporary_cooldown' : 'allowed'

    const { data: updated, error: updateError } = await supabase
      .from('spam_guard_state')
      .update({
        quarantine_until: null,
        quarantine_reason: '',
        block_status: nextStatus,
        block_reason: activeCooldown ? existing.last_reason || existing.block_reason || '' : '',
        last_reason: `Quarantine released manually by ${adminName}`,
        updated_at: now,
      })
      .eq('id', stateId)
      .select()
      .single()

    if (updateError) throw updateError

    await insertSpamGuardEvent(existing, {
      now,
      action: 'block_released',
      reason: `Quarantine released manually by ${adminName}`,
      block_status: nextStatus,
      block_until: activeCooldown ? existing.cooldown_until : null,
      admin_note: `Released by ${adminName}`,
      metadata: {
        released_by: adminName,
        released_type: 'seven_day_quarantine',
        previous_quarantine_until: existing.quarantine_until,
      },
    })

    return res.status(200).json({
      ok: true,
      message: '7-day quarantine released',
      state: formatState(updated),
    })
  } catch (error) {
    console.error('ADMIN SPAM GUARD QUARANTINE RELEASE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to release quarantine',
      error: error.message,
    })
  }
}

export async function blockAdminSpamGuardPermanently(req, res) {
  try {
    const stateId = String(req.params.stateId || '').trim()
    const reason = cleanReason(req.body?.reason || req.body?.note || '')

    if (reason.length < 3) {
      return res.status(400).json({
        ok: false,
        message: 'Permanent block reason is required',
      })
    }

    const { data: existing, errorResponse } = await getSpamGuardStateById(stateId)

    if (errorResponse) {
      return res.status(errorResponse.status).json({
        ok: false,
        message: errorResponse.message,
      })
    }

    const now = new Date().toISOString()
    const adminName = getAdminName(req)

    const { data: updated, error: updateError } = await supabase
      .from('spam_guard_state')
      .update({
        is_permanent_blocked: true,
        permanent_blocked_at: now,
        permanent_blocked_by: adminName,
        permanent_block_reason: reason,
        cooldown_until: null,
        quarantine_until: null,
        block_status: 'permanent_block',
        block_reason: reason,
        last_reason: `Permanently blocked by ${adminName}`,
        updated_at: now,
      })
      .eq('id', stateId)
      .select()
      .single()

    if (updateError) throw updateError

    await insertSpamGuardEvent(existing, {
      now,
      action: 'permanent_blocked',
      reason,
      block_status: 'permanent_block',
      block_until: null,
      admin_note: reason,
      metadata: {
        blocked_by: adminName,
        previous_block_status: existing.block_status || '',
        previous_cooldown_until: existing.cooldown_until,
        previous_quarantine_until: existing.quarantine_until,
      },
    })

    return res.status(200).json({
      ok: true,
      message: 'Spam identity permanently blocked',
      state: formatState(updated),
    })
  } catch (error) {
    console.error('ADMIN SPAM GUARD PERMANENT BLOCK ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to permanently block spam identity',
      error: error.message,
    })
  }
}

export async function unblockAdminSpamGuardPermanent(req, res) {
  try {
    const stateId = String(req.params.stateId || '').trim()
    const reason = cleanReason(req.body?.reason || req.body?.note || 'Manual unblock')
    const { data: existing, errorResponse } = await getSpamGuardStateById(stateId)

    if (errorResponse) {
      return res.status(errorResponse.status).json({
        ok: false,
        message: errorResponse.message,
      })
    }

    const now = new Date().toISOString()
    const adminName = getAdminName(req)

    const { data: updated, error: updateError } = await supabase
      .from('spam_guard_state')
      .update({
        is_permanent_blocked: false,
        permanent_unblocked_at: now,
        permanent_unblocked_by: adminName,
        permanent_unblock_reason: reason,
        cooldown_until: null,
        quarantine_until: null,
        block_status: 'allowed',
        block_reason: '',
        request_count: 0,
        window_started_at: now,
        last_reason: `Permanent block removed by ${adminName}`,
        updated_at: now,
      })
      .eq('id', stateId)
      .select()
      .single()

    if (updateError) throw updateError

    await insertSpamGuardEvent(existing, {
      now,
      action: 'permanent_unblocked',
      reason,
      block_status: 'allowed',
      block_until: null,
      admin_note: reason,
      metadata: {
        unblocked_by: adminName,
        previous_permanent_blocked_at: existing.permanent_blocked_at,
        previous_permanent_block_reason: existing.permanent_block_reason,
      },
    })

    return res.status(200).json({
      ok: true,
      message: 'Permanent block removed',
      state: formatState(updated),
    })
  } catch (error) {
    console.error('ADMIN SPAM GUARD PERMANENT UNBLOCK ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to unblock spam identity',
      error: error.message,
    })
  }
}
