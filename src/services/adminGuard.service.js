import crypto from 'crypto'
import { isIP } from 'node:net'
import { supabase } from '../config/supabase.js'

const ADMIN_DEVICE_COOKIE = 'shadow_admin_device'
const TRUSTED_DEVICE_DAYS = 90
const STALE_FAILED_WINDOW_MS = 24 * 60 * 60 * 1000

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function normalizeEmail(value) {
  return cleanText(value, 320).toLowerCase()
}

function normalizeSingleIp(value) {
  const raw = cleanText(value, 150).replace(/^::ffff:/, '')
  return isIP(raw) ? raw : ''
}

function getForwardedIp(value) {
  const candidates = String(value || '')
    .split(',')
    .map((item) => normalizeSingleIp(item))
    .filter(Boolean)

  return candidates[0] || ''
}

export function getAdminClientIp(req) {
  return (
    getForwardedIp(req.headers['cf-connecting-ip'])
    || getForwardedIp(req.headers['x-real-ip'])
    || getForwardedIp(req.headers['x-forwarded-for'])
    || normalizeSingleIp(req.socket?.remoteAddress)
    || 'unknown'
  )
}

function getUserAgent(req) {
  return cleanText(req.headers['user-agent'], 1000)
}

function parseCookies(req) {
  return String(req.headers.cookie || '')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((acc, item) => {
      const index = item.indexOf('=')
      if (index <= 0) return acc
      const key = item.slice(0, index).trim()
      const value = item.slice(index + 1).trim()
      acc[key] = decodeURIComponent(value)
      return acc
    }, {})
}

function hashToken(token) {
  return crypto
    .createHash('sha256')
    .update(String(token || ''))
    .digest('hex')
}

function createDeviceToken() {
  return crypto.randomBytes(32).toString('hex')
}

function createDeviceId(token) {
  return crypto
    .createHash('sha256')
    .update(String(token || ''))
    .digest('hex')
    .slice(0, 32)
}

function getCookieOptions() {
  const secure = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER)
  return {
    httpOnly: true,
    secure,
    sameSite: secure ? 'none' : 'lax',
    maxAge: TRUSTED_DEVICE_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  }
}

function resolveBlock(failedCount, isTrusted) {
  const count = Number(failedCount || 0)

  if (isTrusted) {
    if (count >= 16) return { status: 'seven_day_block', type: 'seven_day', seconds: 7 * 24 * 60 * 60, level: 4 }
    if (count >= 12) return { status: 'day_block', type: 'day', seconds: 24 * 60 * 60, level: 3 }
    if (count >= 8) return { status: 'one_hour_block', type: 'one_hour', seconds: 60 * 60, level: 2 }
    if (count >= 5) return { status: 'temporary_block', type: 'temporary', seconds: 15 * 60, level: 1 }
    return null
  }

  if (count >= 10) return { status: 'seven_day_block', type: 'seven_day', seconds: 7 * 24 * 60 * 60, level: 4 }
  if (count >= 8) return { status: 'day_block', type: 'day', seconds: 24 * 60 * 60, level: 3 }
  if (count >= 5) return { status: 'one_hour_block', type: 'one_hour', seconds: 60 * 60, level: 2 }
  if (count >= 3) return { status: 'temporary_block', type: 'temporary', seconds: 15 * 60, level: 1 }

  return null
}

function blockCode(status) {
  if (status === 'seven_day_block') return 'ADMIN_SEVEN_DAY_BLOCK'
  if (status === 'permanent_block') return 'ADMIN_PERMANENT_BLOCK'
  return 'ADMIN_TEMPORARY_BLOCK'
}

function blockMessage(status, retryAfterSeconds) {
  if (status === 'permanent_block') return 'This admin login identity is permanently blocked.'
  if (status === 'seven_day_block') return 'Admin login is blocked for 7 days because of repeated failed attempts.'
  return `Too many failed admin login attempts. Please try again in ${Math.ceil(Number(retryAfterSeconds || 60) / 60)} minute(s).`
}

function activeUntil(value) {
  if (!value) return false
  return new Date(value).getTime() > Date.now()
}

function retryAfter(value) {
  if (!value) return 60
  return Math.max(1, Math.ceil((new Date(value).getTime() - Date.now()) / 1000))
}

async function getTrustedDevice(ctx) {
  if (!ctx.deviceTokenHash) return null

  const { data, error } = await supabase
    .from('admin_trusted_devices')
    .select('*')
    .eq('device_token_hash', ctx.deviceTokenHash)
    .eq('is_active', true)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  await supabase
    .from('admin_trusted_devices')
    .update({
      last_seen_at: new Date().toISOString(),
      ip_address: ctx.ipAddress,
      user_agent: ctx.userAgent,
      updated_at: new Date().toISOString(),
    })
    .eq('id', data.id)

  return data
}

async function getTrustedIp(ctx) {
  if (!ctx.ipAddress || ctx.ipAddress === 'unknown') return null

  const { data, error } = await supabase
    .from('admin_trusted_ips')
    .select('*')
    .eq('ip_address', ctx.ipAddress)
    .eq('is_active', true)
    .maybeSingle()

  if (error) throw error

  if (data) {
    await supabase
      .from('admin_trusted_ips')
      .update({
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', data.id)
  }

  return data || null
}

async function buildContext(req, email = '') {
  const cookies = parseCookies(req)
  const deviceToken = cleanText(cookies[ADMIN_DEVICE_COOKIE], 300)
  const ipAddress = getAdminClientIp(req)
  const userAgent = getUserAgent(req)
  const deviceTokenHash = deviceToken ? hashToken(deviceToken) : ''
  const deviceId = deviceToken ? createDeviceId(deviceToken) : ''
  const attemptedEmail = normalizeEmail(email)
  const guardKey = `ip:${ipAddress}`
  const ctx = {
    guardKey,
    ipAddress,
    userAgent,
    deviceToken,
    deviceTokenHash,
    deviceId,
    attemptedEmail,
    trustedDevice: null,
    trustedIp: null,
    isTrusted: false,
  }

  ctx.trustedDevice = await getTrustedDevice(ctx)
  ctx.trustedIp = await getTrustedIp(ctx)
  ctx.isTrusted = Boolean(ctx.trustedDevice || ctx.trustedIp)

  return ctx
}

async function findState(guardKey) {
  const { data, error } = await supabase
    .from('admin_guard_state')
    .select('*')
    .eq('guard_key', guardKey)
    .maybeSingle()

  if (error) throw error
  return data || null
}

async function ensureState(ctx) {
  const existing = await findState(ctx.guardKey)

  if (existing) return existing

  const now = new Date().toISOString()
  const payload = {
    guard_key: ctx.guardKey,
    ip_address: ctx.ipAddress,
    device_id: ctx.deviceId,
    attempted_email: ctx.attemptedEmail,
    user_agent: ctx.userAgent,
    block_status: 'allowed',
    first_seen_at: now,
    created_at: now,
    updated_at: now,
  }

  const { data, error } = await supabase
    .from('admin_guard_state')
    .insert(payload)
    .select()
    .single()

  if (error) {
    const retry = await findState(ctx.guardKey)
    if (retry) return retry
    throw error
  }

  return data
}

async function insertEvent(state, ctx, payload) {
  const now = payload.occurred_at || new Date().toISOString()

  const { error } = await supabase
    .from('admin_login_events')
    .insert({
      state_id: state?.id || null,
      guard_key: ctx.guardKey,
      ip_address: ctx.ipAddress,
      device_id: ctx.deviceId,
      trusted_device_id: ctx.trustedDevice?.id || null,
      attempted_email: ctx.attemptedEmail,
      admin_id: payload.admin_id || '',
      admin_email: payload.admin_email || '',
      user_agent: ctx.userAgent,
      action: payload.action || 'login_attempt',
      result: payload.result || 'failed',
      reason: payload.reason || '',
      failed_count: Number(payload.failed_count || state?.failed_count || 0),
      block_level: Number(payload.block_level || state?.block_level || 0),
      block_status: payload.block_status || state?.block_status || 'allowed',
      blocked_until: payload.blocked_until || state?.blocked_until || null,
      is_trusted_device: Boolean(ctx.isTrusted),
      metadata: payload.metadata || {},
      occurred_at: now,
      created_at: now,
    })

  if (error) throw error
}

async function updateState(id, payload) {
  const { data, error } = await supabase
    .from('admin_guard_state')
    .update({
      ...payload,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single()

  if (error) throw error
  return data
}

export async function checkAdminLoginAllowed({ req, email }) {
  try {
    const ctx = await buildContext(req, email)
    const state = await ensureState(ctx)

    if (state.is_permanent_blocked) {
      await insertEvent(state, ctx, {
        action: 'login_blocked',
        result: 'blocked',
        reason: state.permanent_block_reason || 'Permanent admin login block',
        block_status: 'permanent_block',
        blocked_until: null,
      })

      return {
        allowed: false,
        ctx,
        state,
        code: 'ADMIN_PERMANENT_BLOCK',
        status: 'permanent_block',
        message: blockMessage('permanent_block'),
        retry_after_seconds: 86400,
      }
    }

    if (activeUntil(state.blocked_until)) {
      const seconds = retryAfter(state.blocked_until)

      await insertEvent(state, ctx, {
        action: 'login_blocked',
        result: 'blocked',
        reason: state.last_reason || 'Admin login block active',
        block_status: state.block_status || 'temporary_block',
        blocked_until: state.blocked_until,
      })

      return {
        allowed: false,
        ctx,
        state,
        code: blockCode(state.block_status),
        status: state.block_status,
        message: blockMessage(state.block_status, seconds),
        retry_after_seconds: seconds,
        blocked_until: state.blocked_until,
      }
    }

    return { allowed: true, ctx, state }
  } catch (error) {
    console.error('ADMIN GUARD CHECK ERROR:', error)
    return { allowed: true, ctx: null, state: null, guard_error: true }
  }
}

export async function recordAdminLoginFailure({ req, email, reason = 'Invalid admin email or password' }) {
  try {
    const ctx = await buildContext(req, email)
    const state = await ensureState(ctx)
    const now = new Date()
    const lastFailedAt = state.last_failed_at ? new Date(state.last_failed_at).getTime() : 0
    const stale = lastFailedAt && now.getTime() - lastFailedAt > STALE_FAILED_WINDOW_MS
    const currentFailedCount = stale ? 0 : Number(state.failed_count || 0)
    const nextFailedCount = currentFailedCount + 1
    const block = resolveBlock(nextFailedCount, ctx.isTrusted)
    const blockedUntil = block
      ? new Date(now.getTime() + block.seconds * 1000).toISOString()
      : null
    const status = block ? block.status : 'allowed'
    const blockLevel = block ? block.level : Number(state.block_level || 0)

    const updated = await updateState(state.id, {
      ip_address: ctx.ipAddress,
      device_id: ctx.deviceId,
      attempted_email: ctx.attemptedEmail,
      user_agent: ctx.userAgent,
      failed_count: nextFailedCount,
      block_level: blockLevel,
      block_status: status,
      block_type: block?.type || '',
      blocked_until: blockedUntil,
      last_attempt_status: block ? 'blocked' : 'failed',
      last_reason: block ? `Auto blocked after ${nextFailedCount} failed admin login attempts` : reason,
      last_attempt_at: now.toISOString(),
      last_failed_at: now.toISOString(),
    })

    await insertEvent(updated, ctx, {
      action: block ? 'auto_blocked' : 'login_failed',
      result: block ? 'blocked' : 'failed',
      reason: updated.last_reason,
      failed_count: nextFailedCount,
      block_level: blockLevel,
      block_status: status,
      blocked_until: blockedUntil,
      metadata: {
        trusted_device: Boolean(ctx.trustedDevice),
        trusted_ip: Boolean(ctx.trustedIp),
      },
    })

    return {
      locked: Boolean(block),
      attemptsLeft: block ? 0 : Math.max(0, (ctx.isTrusted ? 5 : 3) - nextFailedCount),
      failed_count: nextFailedCount,
      block_status: status,
      blocked_until: blockedUntil,
      retry_after_seconds: blockedUntil ? retryAfter(blockedUntil) : 0,
      code: block ? blockCode(status) : 'ADMIN_LOGIN_FAILED',
      message: block
        ? blockMessage(status, retryAfter(blockedUntil))
        : `Email or password is incorrect. ${Math.max(0, (ctx.isTrusted ? 5 : 3) - nextFailedCount)} attempt(s) left before temporary block.`,
    }
  } catch (error) {
    console.error('ADMIN GUARD FAILURE RECORD ERROR:', error)
    return {
      locked: false,
      attemptsLeft: 1,
      failed_count: 0,
      block_status: 'allowed',
      code: 'ADMIN_LOGIN_FAILED',
      message: 'Email or password is incorrect.',
    }
  }
}

export async function recordAdminLoginSuccess({ req, res, email, admin }) {
  try {
    const ctx = await buildContext(req, email)
    const state = await ensureState(ctx)
    const now = new Date().toISOString()
    const token = ctx.deviceToken || createDeviceToken()
    const deviceTokenHash = hashToken(token)
    const deviceId = createDeviceId(token)

    let trustedDevice = ctx.trustedDevice

    if (!trustedDevice) {
      const { data, error } = await supabase
        .from('admin_trusted_devices')
        .insert({
          admin_id: admin?.id || '',
          admin_email: admin?.email || normalizeEmail(email),
          device_id: deviceId,
          device_token_hash: deviceTokenHash,
          device_label: 'Admin browser',
          ip_address: ctx.ipAddress,
          user_agent: ctx.userAgent,
          is_active: true,
          trusted_at: now,
          last_seen_at: now,
          created_at: now,
          updated_at: now,
        })
        .select()
        .single()

      if (!error) trustedDevice = data
    }

    if (res?.cookie) {
      res.cookie(ADMIN_DEVICE_COOKIE, token, getCookieOptions())
    }

    const updated = await updateState(state.id, {
      ip_address: ctx.ipAddress,
      device_id: deviceId,
      attempted_email: normalizeEmail(email),
      admin_id: admin?.id || '',
      admin_email: admin?.email || normalizeEmail(email),
      user_agent: ctx.userAgent,
      failed_count: 0,
      success_count: Number(state.success_count || 0) + 1,
      block_status: 'allowed',
      block_type: '',
      blocked_until: null,
      last_attempt_status: 'success',
      last_reason: 'Admin login succeeded',
      last_attempt_at: now,
      last_success_at: now,
    })

    await insertEvent(updated, {
      ...ctx,
      deviceId,
      trustedDevice,
      isTrusted: true,
    }, {
      action: 'login_success',
      result: 'success',
      reason: 'Admin login succeeded',
      failed_count: 0,
      block_level: Number(updated.block_level || 0),
      block_status: 'allowed',
      blocked_until: null,
      admin_id: admin?.id || '',
      admin_email: admin?.email || normalizeEmail(email),
      metadata: {
        trusted_device_created: !ctx.trustedDevice,
      },
    })

    return {
      trusted_device: true,
      trusted_device_id: trustedDevice?.id || null,
    }
  } catch (error) {
    console.error('ADMIN GUARD SUCCESS RECORD ERROR:', error)
    return {
      trusted_device: false,
      trusted_device_id: null,
    }
  }
}

export async function writeAdminGuardEventFromController(state, payload = {}) {
  const ctx = {
    guardKey: state.guard_key,
    ipAddress: state.ip_address || '',
    deviceId: state.device_id || '',
    attemptedEmail: state.attempted_email || '',
    userAgent: state.user_agent || '',
    trustedDevice: null,
    trustedIp: null,
    isTrusted: false,
  }

  await insertEvent(state, ctx, payload)
}
