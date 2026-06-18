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

function formatState(row) {
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
    is_in_cooldown: Boolean(
      row.cooldown_until
      && new Date(row.cooldown_until).getTime() > Date.now()
    ),
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
    metadata: row.metadata || {},
    occurred_at: row.occurred_at,
    created_at: row.created_at,
  }
}

async function countRows(builder) {
  const { count, error } = await builder.select('id', {
    count: 'exact',
    head: true,
  })

  if (error) throw error
  return count || 0
}

export async function getAdminSpamGuardOverview(req, res) {
  try {
    const now = new Date().toISOString()
    const dayStart = new Date()
    dayStart.setHours(0, 0, 0, 0)

    const [
      totalTracked,
      activeCooldowns,
      offendersToday,
      highSpamScore,
      visitorTrackingCooldowns,
      accountAccessCooldowns,
      readerActionCooldowns,
      paymentCooldowns,
    ] = await Promise.all([
      countRows(supabase.from('spam_guard_state')),
      countRows(
        supabase
          .from('spam_guard_state')
          .gt('cooldown_until', now)
      ),
      countRows(
        supabase
          .from('spam_guard_events')
          .eq('action', 'cooldown_started')
          .gte('occurred_at', dayStart.toISOString())
      ),
      countRows(
        supabase
          .from('spam_guard_state')
          .gte('spam_score', 90)
      ),
      countRows(
        supabase
          .from('spam_guard_state')
          .eq('scope', 'visitor_tracking')
          .gt('cooldown_until', now)
      ),
      countRows(
        supabase
          .from('spam_guard_state')
          .eq('scope', 'account_access')
          .gt('cooldown_until', now)
      ),
      countRows(
        supabase
          .from('spam_guard_state')
          .eq('scope', 'reader_actions')
          .gt('cooldown_until', now)
      ),
      countRows(
        supabase
          .from('spam_guard_state')
          .eq('scope', 'payment_actions')
          .gt('cooldown_until', now)
      ),
    ])

    return res.status(200).json({
      ok: true,
      summary: {
        total_tracked: totalTracked,
        active_cooldowns: activeCooldowns,
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
        'id, guard_key, scope, ip_address, visitor_id, account_id, window_started_at, request_count, offense_count, cooldown_until, spam_score, last_reason, last_endpoint, last_method, first_seen_at, last_seen_at, last_offense_at, created_at, updated_at',
        { count: 'exact' }
      )
      .order('updated_at', { ascending: false })
      .range(from, to)

    if (scope) query = query.eq('scope', scope)

    if (filter === 'cooldown') {
      query = query.gt('cooldown_until', now)
    } else if (filter === 'released') {
      query = query.or(`cooldown_until.is.null,cooldown_until.lte.${now}`)
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
          `guard_key.ilike.%${q}%,scope.ilike.%${q}%,visitor_id.ilike.%${q}%,account_id.ilike.%${q}%,last_endpoint.ilike.%${q}%,last_reason.ilike.%${q}%`
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
        'id, state_id, guard_key, scope, ip_address, visitor_id, account_id, endpoint, method, action, reason, request_count, window_seconds, offense_count, spam_score, cooldown_until, metadata, occurred_at, created_at',
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
          `guard_key.ilike.%${q}%,scope.ilike.%${q}%,visitor_id.ilike.%${q}%,account_id.ilike.%${q}%,endpoint.ilike.%${q}%,reason.ilike.%${q}%,action.ilike.%${q}%`
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

    if (!/^[0-9a-f-]{36}$/i.test(stateId)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid spam guard state ID',
      })
    }

    const { data: existing, error: findError } = await supabase
      .from('spam_guard_state')
      .select('*')
      .eq('id', stateId)
      .maybeSingle()

    if (findError) throw findError

    if (!existing) {
      return res.status(404).json({
        ok: false,
        message: 'Spam guard state not found',
      })
    }

    const now = new Date().toISOString()
    const adminName = String(
      req.admin?.name
      || req.admin?.username
      || req.admin?.email
      || 'Admin'
    ).slice(0, 160)

    const { data: updated, error: updateError } = await supabase
      .from('spam_guard_state')
      .update({
        cooldown_until: null,
        request_count: 0,
        window_started_at: now,
        last_reason: `Cooldown released manually by ${adminName}`,
        updated_at: now,
      })
      .eq('id', stateId)
      .select()
      .single()

    if (updateError) throw updateError

    const { error: eventError } = await supabase
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
        action: 'cooldown_released',
        reason: `Released manually by ${adminName}`,
        request_count: Number(existing.request_count || 0),
        window_seconds: 0,
        offense_count: Number(existing.offense_count || 0),
        spam_score: Number(existing.spam_score || 0),
        cooldown_until: null,
        metadata: {
          released_by: adminName,
          previous_cooldown_until: existing.cooldown_until,
        },
        occurred_at: now,
        created_at: now,
      })

    if (eventError) throw eventError

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
