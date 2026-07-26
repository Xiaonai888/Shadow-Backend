import { isIP } from 'node:net'
import { supabase } from '../config/supabase.js'

const RESTRICTION_DURATIONS = {
  '1h': 60 * 60,
  '6h': 6 * 60 * 60,
  '24h': 24 * 60 * 60,
  '3d': 3 * 24 * 60 * 60,
  '7d': 7 * 24 * 60 * 60,
}

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

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function isFuture(value) {
  return Boolean(value && new Date(value).getTime() > Date.now())
}

function getAdminName(req) {
  return cleanText(
    req.admin?.name
      || req.admin?.username
      || req.admin?.email
      || req.admin?.admin_id
      || req.admin?.id
      || 'Admin',
    160
  )
}

function resolveStateStatus(row) {
  if (isFuture(row.quarantine_until)) return 'temporary_restriction'
  if (isFuture(row.cooldown_until)) return 'temporary_cooldown'
  return 'allowed'
}

function formatState(row) {
  const blockStatus = resolveStateStatus(row)
  const restrictionUntil = blockStatus === 'temporary_restriction'
    ? row.quarantine_until
    : blockStatus === 'temporary_cooldown'
      ? row.cooldown_until
      : null

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
    restriction_until: restrictionUntil,
    quarantine_started_at: row.quarantine_started_at,
    quarantine_reason: row.quarantine_reason || '',
    block_status: blockStatus,
    block_reason: row.block_reason || '',
    is_in_cooldown: blockStatus === 'temporary_cooldown',
    is_in_restriction: blockStatus === 'temporary_restriction',
    is_in_quarantine: blockStatus === 'temporary_restriction',
    is_permanent_blocked: false,
    permanent_blocked_at: null,
    permanent_blocked_by: '',
    permanent_block_reason: '',
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
  const blockStatus = row.block_status === 'seven_day_quarantine'
    || row.block_status === 'permanent_block'
    ? 'temporary_restriction'
    : row.block_status || ''

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
    block_status: blockStatus,
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
    return {
      errorResponse: {
        status: 400,
        message: 'Invalid spam guard state ID',
      },
    }
  }

  const { data, error } = await supabase
    .from('spam_guard_state')
    .select('*')
    .eq('id', stateId)
    .maybeSingle()

  if (error) throw error

  if (!data) {
    return {
      errorResponse: {
        status: 404,
        message: 'Spam guard state not found',
      },
    }
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

function normalizeDuration(value, fallback = '7d') {
  const duration = cleanText(value, 20).toLowerCase()
  return RESTRICTION_DURATIONS[duration] ? duration : fallback
}

function restrictionUntil(duration) {
  const seconds = RESTRICTION_DURATIONS[duration]
  return new Date(Date.now() + seconds * 1000).toISOString()
}

async function applyRestriction(req, res, legacyPermanentRoute = false) {
  try {
    const stateId = cleanText(req.params.stateId, 80)
    const reason = cleanText(
      req.body?.reason || req.body?.note,
      500
    )
    const duration = normalizeDuration(
      req.body?.duration,
      legacyPermanentRoute ? '7d' : '24h'
    )

    if (reason.length < 3) {
      return res.status(400).json({
        ok: false,
        message: 'Temporary restriction reason is required',
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
    const blockUntil = restrictionUntil(duration)
    const adminName = getAdminName(req)

    const { data: updated, error: updateError } = await supabase
      .from('spam_guard_state')
      .update({
        is_permanent_blocked: false,
        permanent_blocked_at: null,
        permanent_blocked_by: null,
        permanent_block_reason: null,
        cooldown_until: null,
        quarantine_until: blockUntil,
        quarantine_started_at: now,
        quarantine_reason: reason,
        block_status: 'temporary_restriction',
        block_reason: reason,
        request_count: 0,
        window_started_at: now,
        last_reason: `Temporary restriction applied by ${adminName}`,
        updated_at: now,
      })
      .eq('id', stateId)
      .select()
      .single()

    if (updateError) throw updateError

    await insertSpamGuardEvent(existing, {
      now,
      action: 'temporary_restriction_started',
      reason,
      block_status: 'temporary_restriction',
      block_until: blockUntil,
      admin_note: reason,
      metadata: {
        applied_by: adminName,
        duration,
        legacy_permanent_route: legacyPermanentRoute,
        automatic_permanent_block: false,
        previous_block_status: existing.block_status || '',
        previous_cooldown_until: existing.cooldown_until,
        previous_quarantine_until: existing.quarantine_until,
      },
    })

    return res.status(200).json({
      ok: true,
      message: legacyPermanentRoute
        ? 'Permanent blocks are disabled. A 7-day temporary restriction was applied.'
        : `Temporary restriction applied for ${duration}`,
      state: formatState(updated),
    })
  } catch (error) {
    console.error('ADMIN SPAM GUARD RESTRICTION ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to apply temporary restriction',
      error: error.message,
    })
  }
}

async function releaseAllRestrictions(req, res, legacyUnblockRoute = false) {
  try {
    const stateId = cleanText(req.params.stateId, 80)
    const reason = cleanText(
      req.body?.reason || req.body?.note || 'Manual release',
      500
    )
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
        permanent_blocked_at: null,
        permanent_blocked_by: null,
        permanent_block_reason: null,
        permanent_unblocked_at: now,
        permanent_unblocked_by: adminName,
        permanent_unblock_reason: reason,
        cooldown_until: null,
        quarantine_until: null,
        quarantine_started_at: null,
        quarantine_reason: null,
        block_status: 'allowed',
        block_reason: '',
        request_count: 0,
        window_started_at: now,
        last_reason: `Restriction released by ${adminName}`,
        updated_at: now,
      })
      .eq('id', stateId)
      .select()
      .single()

    if (updateError) throw updateError

    await insertSpamGuardEvent(existing, {
      now,
      action: 'restriction_released',
      reason,
      block_status: 'allowed',
      block_until: null,
      admin_note: reason,
      metadata: {
        released_by: adminName,
        legacy_unblock_route: legacyUnblockRoute,
        previous_block_status: existing.block_status || '',
        previous_cooldown_until: existing.cooldown_until,
        previous_quarantine_until: existing.quarantine_until,
      },
    })

    return res.status(200).json({
      ok: true,
      message: 'Temporary restriction released',
      state: formatState(updated),
    })
  } catch (error) {
    console.error('ADMIN SPAM GUARD RELEASE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to release temporary restriction',
      error: error.message,
    })
  }
}

export async function getAdminSpamGuardOverview(req, res) {
  try {
    const now = new Date().toISOString()
    const dayStart = new Date()
    dayStart.setHours(0, 0, 0, 0)

    const [
      totalTracked,
      activeCooldowns,
      activeRestrictions,
      offensesToday,
      highSpamScore,
      visitorTrackingCooldowns,
      accountAccessCooldowns,
      readerActionCooldowns,
      paymentCooldowns,
    ] = await Promise.all([
      countRows('spam_guard_state'),
      countRows(
        'spam_guard_state',
        (query) => query.gt('cooldown_until', now)
      ),
      countRows(
        'spam_guard_state',
        (query) => query.gt('quarantine_until', now)
      ),
      countRows(
        'spam_guard_events',
        (query) => query
          .in('action', [
            'cooldown_started',
            'temporary_restriction_started',
            'quarantine_started',
          ])
          .gte('occurred_at', dayStart.toISOString())
      ),
      countRows(
        'spam_guard_state',
        (query) => query.gte('spam_score', 50)
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
        active_restrictions: activeRestrictions,
        active_quarantines: activeRestrictions,
        permanent_blocks: 0,
        active_blocks: activeCooldowns + activeRestrictions,
        offenses_today: offensesToday,
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
    const filter = cleanText(req.query.filter || 'all', 40).toLowerCase()
    const scope = cleanText(req.query.scope, 80).toLowerCase()
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
      query = query.gt('cooldown_until', now)
    } else if (
      filter === 'restriction'
      || filter === 'quarantine'
      || filter === 'permanent'
    ) {
      query = query.gt('quarantine_until', now)
    } else if (filter === 'blocked') {
      query = query.or(
        `cooldown_until.gt.${now},quarantine_until.gt.${now}`
      )
    } else if (filter === 'released') {
      query = query
        .or(`cooldown_until.is.null,cooldown_until.lte.${now}`)
        .or(`quarantine_until.is.null,quarantine_until.lte.${now}`)
    } else if (filter === 'high_score') {
      query = query.gte('spam_score', 50)
    } else if (filter === 'repeat_offender') {
      query = query.gte('offense_count', 2)
    }

    if (q) {
      if (isIP(q)) {
        query = query.eq('ip_address', q)
      } else {
        query = query.or(
          `guard_key.ilike.%${q}%,scope.ilike.%${q}%,visitor_id.ilike.%${q}%,account_id.ilike.%${q}%,last_endpoint.ilike.%${q}%,last_reason.ilike.%${q}%,block_reason.ilike.%${q}%,quarantine_reason.ilike.%${q}%`
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
    const scope = cleanText(req.query.scope, 80).toLowerCase()
    const action = cleanText(req.query.action, 80).toLowerCase()
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
    const stateId = cleanText(req.params.stateId, 80)
    const { data: existing, errorResponse } = await getSpamGuardStateById(stateId)

    if (errorResponse) {
      return res.status(errorResponse.status).json({
        ok: false,
        message: errorResponse.message,
      })
    }

    const now = new Date().toISOString()
    const adminName = getAdminName(req)
    const activeRestriction = isFuture(existing.quarantine_until)
    const nextStatus = activeRestriction
      ? 'temporary_restriction'
      : 'allowed'

    const { data: updated, error: updateError } = await supabase
      .from('spam_guard_state')
      .update({
        is_permanent_blocked: false,
        permanent_blocked_at: null,
        permanent_blocked_by: null,
        permanent_block_reason: null,
        cooldown_until: null,
        request_count: 0,
        window_started_at: now,
        block_status: nextStatus,
        block_reason: activeRestriction
          ? existing.quarantine_reason || existing.block_reason || ''
          : '',
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
      block_until: activeRestriction
        ? existing.quarantine_until
        : null,
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
    console.error('ADMIN SPAM GUARD COOLDOWN RELEASE ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to release temporary cooldown',
      error: error.message,
    })
  }
}

export async function releaseAdminSpamGuardQuarantine(req, res) {
  return releaseAllRestrictions(req, res)
}

export async function applyAdminSpamGuardRestriction(req, res) {
  return applyRestriction(req, res)
}

export async function releaseAdminSpamGuardRestriction(req, res) {
  return releaseAllRestrictions(req, res)
}

export async function blockAdminSpamGuardPermanently(req, res) {
  return applyRestriction(req, res, true)
}

export async function unblockAdminSpamGuardPermanent(req, res) {
  return releaseAllRestrictions(req, res, true)
}
