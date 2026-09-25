import { isIP } from 'node:net'
import jwt from 'jsonwebtoken'
import { supabase } from '../config/supabase.js'
import {
  publishSecurityEvent,
  reportGuardState,
} from '../services/securityControlPlane.service.js'

const MAX_RESTRICTION_SECONDS = 7 * 24 * 60 * 60
const DEFAULT_IP_FALLBACK_MULTIPLIER = 5
const MAX_ACTIVE_RESTRICTIONS = 500
const BLOCK_EVENT_THROTTLE_MS = 60 * 1000

const activeRestrictions = new Map()
const lastBlockEventAt = new Map()

const READER_CACHE_TTL_MS = 2000
const READER_CACHE_MAX_SKIPS = 30
const READER_CACHE_MAX_BURST = 4
const READER_CACHE_MAX_KEYS = 2048
const readerReadCache = new Map()

function readerCacheKey(identity) {
  return `${identity.guardKey}|${identity.ipAddress || ''}`
}

function canUseReaderCache(scope, req, identity) {
  if (scope !== 'reader_read' || req.method !== 'GET' || identity.identityType !== 'account' || !identity.accountId) return false

  const item = readerReadCache.get(readerCacheKey(identity))
  if (!item) return false

  const now = Date.now()
  if (item.periodUntil <= now) {
    item.periodUntil = now + 60000
    item.skipped = 0
  }

  if (item.expiresAt <= now || item.skipped >= READER_CACHE_MAX_SKIPS || item.burst >= READER_CACHE_MAX_BURST) return false

  item.skipped += 1
  item.burst += 1
  req.spamGuard = { ...item.snapshot }
  return true
}

function updateReaderCache(scope, req, identity, result, threshold) {
  if (scope !== 'reader_read' || req.method !== 'GET' || identity.identityType !== 'account' || !identity.accountId) return

  const now = Date.now()
  const key = readerCacheKey(identity)
  const item = readerReadCache.get(key) || { periodUntil: now + 60000, skipped: 0, burst: 0, expiresAt: 0, snapshot: null }
  if (item.periodUntil <= now) {
    item.periodUntil = now + 60000
    item.skipped = 0
  }

  item.expiresAt = result?.allowed === true &&
    result?.block_status === 'allowed' &&
    Number(result.request_count) <= threshold - (READER_CACHE_MAX_SKIPS * 2) &&
    Number(result.offense_count) === 0 &&
    Number(result.spam_score) === 0 &&
    !result.cooldown_until && !result.quarantine_until &&
    !result.is_permanent_blocked && item.skipped < READER_CACHE_MAX_SKIPS
      ? now + READER_CACHE_TTL_MS
      : 0
  item.burst = 0
  item.snapshot = item.expiresAt ? buildGuardSnapshot({
    result,
    scope,
    guardKey: identity.guardKey,
    identityType: identity.identityType,
  }) : null

  readerReadCache.delete(key)
  readerReadCache.set(key, item)
  if (readerReadCache.size > READER_CACHE_MAX_KEYS) readerReadCache.delete(readerReadCache.keys().next().value)
}


let degraded = false
let lastReportedState = ''

function cleanText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength)
}

function normalizeSingleIp(value) {
  const raw = cleanText(value, 150)
    .trim()
    .replace(/^::ffff:/, '')

  return isIP(raw) ? raw : ''
}

function getForwardedIp(value) {
  const candidates = String(value || '')
    .split(',')
    .map((item) => normalizeSingleIp(item))
    .filter(Boolean)

  return candidates[0] || ''
}

function getClientIp(req) {
  return (
    normalizeSingleIp(req.headers['cf-connecting-ip'])
    || normalizeSingleIp(req.headers['true-client-ip'])
    || normalizeSingleIp(req.headers['x-real-ip'])
    || getForwardedIp(req.headers['x-forwarded-for'])
    || normalizeSingleIp(req.socket?.remoteAddress)
    || ''
  )
}

function readBearerAccountId(req) {
  try {
    const authHeader = cleanText(req.headers.authorization, 5000)
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : ''

    if (!token || !process.env.JWT_SECRET) return ''

    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    return cleanText(
      decoded?.user_id
        || decoded?.admin_id
        || decoded?.id
        || decoded?.sub,
      200
    )
  } catch {
    return ''
  }
}

function readCookieValue(req, name) {
  const cookieHeader = String(req.headers.cookie || '')

  if (!cookieHeader) return ''

  const prefix = `${name}=`
  const pair = cookieHeader
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix))

  if (!pair) return ''

  try {
    return decodeURIComponent(pair.slice(prefix.length))
  } catch {
    return pair.slice(prefix.length)
  }
}

function normalizeVisitorId(value) {
  const visitorId = cleanText(value, 200)

  if (!visitorId) return ''
  if (!/^[a-zA-Z0-9._:-]{6,200}$/.test(visitorId)) return ''

  return visitorId
}

function getVisitorId(req) {
  return normalizeVisitorId(
    req.headers['x-shadow-visitor-id']
      || req.headers['x-visitor-id']
      || req.body?.visitor_id
      || req.query?.visitor_id
      || readCookieValue(req, 'shadow_visitor_id')
      || readCookieValue(req, 'shadowVisitorId')
  )
}

function buildGuardIdentity(req) {
  const accountId = cleanText(
    req.user?.user_id
      || req.user?.admin_id
      || req.user?.id,
    200
  ) || readBearerAccountId(req)

  const visitorId = getVisitorId(req)
  const ipAddress = getClientIp(req)

  const guardKey = accountId
    ? `account:${accountId}`
    : visitorId
      ? `visitor:${visitorId}`
      : ipAddress
        ? `ip:${ipAddress}`
        : ''

  return {
    guardKey,
    accountId,
    visitorId,
    ipAddress,
    identityType: accountId
      ? 'account'
      : visitorId
        ? 'visitor'
        : ipAddress
          ? 'ip'
          : 'unknown',
  }
}

function shouldSkipPath(path, skipPaths) {
  return skipPaths.some((item) => (
    item.endsWith('*')
      ? path.startsWith(item.slice(0, -1))
      : path === item
  ))
}

function normalizeResult(data) {
  if (Array.isArray(data)) return data[0] || null
  return data || null
}

function secondsUntil(value) {
  if (!value) return 0

  const timestamp = new Date(value).getTime()

  if (!Number.isFinite(timestamp)) return 0

  return Math.max(
    0,
    Math.ceil((timestamp - Date.now()) / 1000)
  )
}

function clampRestrictionSeconds(value, fallback = 60) {
  const seconds = Math.max(1, Number(value) || fallback)

  return Math.min(MAX_RESTRICTION_SECONDS, seconds)
}

function resolveRestriction(result) {
  const status = cleanText(
    result?.block_status || result?.status,
    80
  ).toLowerCase()

  const retryAfter = clampRestrictionSeconds(
    result?.retry_after_seconds
      || secondsUntil(result?.quarantine_until)
      || secondsUntil(result?.cooldown_until)
      || 60
  )

  const suspiciousStatus = [
    'suspicious_block',
    'risk_block',
    'temporary_block',
    'seven_day_quarantine',
    'permanent_block',
  ].includes(status)

  const suspicious =
    suspiciousStatus
    || result?.is_permanent_blocked
    || Number(result?.spam_score || 0) >= 50
    || retryAfter > 15 * 60

  if (suspicious) {
    return {
      code: 'TEMPORARY_RESTRICTION',
      header: 'temporary-restriction',
      status: 'temporary_restriction',
      message:
        'Suspicious activity was detected. Access is temporarily restricted.',
      retryAfter,
      severity: retryAfter >= 24 * 60 * 60
        ? 'critical'
        : 'high',
    }
  }

  return {
    code: 'TEMPORARY_COOLDOWN',
    header: 'temporary-cooldown',
    status: 'temporary_cooldown',
    message:
      'Too many requests. Please wait before trying again.',
    retryAfter,
    severity: 'medium',
  }
}

async function evaluateGuard({
  guardKey,
  scope,
  identity,
  requestPath,
  method,
  threshold,
  windowSeconds,
}) {
  const { data, error } = await supabase.rpc(
    'evaluate_spam_guard',
    {
      p_guard_key: guardKey,
      p_scope: scope,
      p_ip_address: identity.ipAddress || null,
      p_visitor_id: identity.visitorId || null,
      p_account_id: identity.accountId || null,
      p_endpoint: requestPath,
      p_method: method,
      p_threshold: threshold,
      p_window_seconds: windowSeconds,
    }
  )

  if (error) throw error

  return normalizeResult(data)
}

function canUseIpFallback(scope, identity) {
  if (
    identity.identityType !== 'visitor'
    || !identity.ipAddress
  ) {
    return false
  }

  return ![
    'account_access',
    'payment_actions',
  ].includes(scope)
}

function buildGuardSnapshot({
  result,
  scope,
  guardKey,
  identityType,
}) {
  return {
    scope,
    guard_key: guardKey,
    identity_type: identityType,
    request_count: Number(result?.request_count || 0),
    offense_count: Number(result?.offense_count || 0),
    spam_score: Number(result?.spam_score || 0),
    cooldown_until: result?.cooldown_until || null,
    quarantine_until: result?.quarantine_until || null,
    block_status: result?.block_status || 'allowed',
  }
}

function restrictionKey(scope, guardKey) {
  return `${scope}|${guardKey}`
}

function evictOldestRestriction() {
  let oldestKey = ''
  let oldestUntil = Infinity

  for (const [key, item] of activeRestrictions.entries()) {
    if (item.until < oldestUntil) {
      oldestUntil = item.until
      oldestKey = key
    }
  }

  if (oldestKey) {
    activeRestrictions.delete(oldestKey)
    lastBlockEventAt.delete(oldestKey)
  }
}

function pruneRestrictions(now = Date.now()) {
  for (const [key, item] of activeRestrictions.entries()) {
    if (item.until <= now) {
      activeRestrictions.delete(key)
      lastBlockEventAt.delete(key)
    }
  }
}

function reportSpamGuardState(
  state,
  reason,
  severity = 'info',
  force = false
) {
  if (!force && state === lastReportedState) return

  lastReportedState = state

  reportGuardState({
    guard: 'spam_guard',
    state,
    reason,
    details: {
      active_restrictions: activeRestrictions.size,
      degraded,
    },
    severity,
  })
}

function publishSpamGuardEvent(
  type,
  severity,
  {
    scope,
    identityType,
    requestPath,
    method,
    result,
    resolved,
  } = {}
) {
  publishSecurityEvent({
    source: 'spam_guard',
    target: 'control_plane',
    type,
    severity,
    payload: {
      scope: scope || null,
      identity_type: identityType || null,
      path: requestPath || null,
      method: cleanText(method, 16).toUpperCase() || null,
      block_status:
        resolved?.status
        || result?.block_status
        || result?.status
        || null,
      retry_after_seconds:
        resolved?.retryAfter
        || Number(result?.retry_after_seconds || 0),
      offense_count: Number(result?.offense_count || 0),
      spam_score: Number(result?.spam_score || 0),
    },
  })
}

function recordRestriction({
  scope,
  guardKey,
  identityType,
  requestPath,
  method,
  result,
  resolved,
}) {
  const now = Date.now()
  const key = restrictionKey(scope, guardKey)

  if (
    !activeRestrictions.has(key)
    && activeRestrictions.size >= MAX_ACTIVE_RESTRICTIONS
  ) {
    evictOldestRestriction()
  }

  activeRestrictions.set(key, {
    until: now + resolved.retryAfter * 1000,
  })

  const lastEventAt = lastBlockEventAt.get(key) || 0

  if (now - lastEventAt >= BLOCK_EVENT_THROTTLE_MS) {
    lastBlockEventAt.set(key, now)

    publishSpamGuardEvent(
      'spam_guard_blocked',
      resolved.severity,
      {
        scope,
        identityType,
        requestPath,
        method,
        result,
        resolved,
      }
    )
  }

  reportSpamGuardState(
    'defending',
    'Spam Guard actively restricting abusive traffic',
    resolved.severity
  )
}

function markHealthy() {
  const wasDegraded = degraded
  degraded = false

  pruneRestrictions()

  if (wasDegraded) {
    publishSecurityEvent({
      source: 'spam_guard',
      target: 'control_plane',
      type: 'spam_guard_recovered',
      severity: 'info',
      payload: {
        active_restrictions: activeRestrictions.size,
      },
    })

    reportSpamGuardState(
      activeRestrictions.size > 0 ? 'defending' : 'monitoring',
      'Spam Guard recovered',
      'info',
      true
    )

    return
  }

  if (
    activeRestrictions.size === 0
    && lastReportedState === 'defending'
  ) {
    reportSpamGuardState(
      'monitoring',
      'No active Spam Guard restrictions',
      'info',
      true
    )
  }
}

function markDegraded(error, scope, requestPath) {
  const wasDegraded = degraded
  degraded = true

  if (!wasDegraded) {
    publishSecurityEvent({
      source: 'spam_guard',
      target: 'control_plane',
      type: 'spam_guard_degraded',
      severity: 'high',
      payload: {
        scope,
        path: requestPath,
        error: cleanText(error?.message || error, 300),
      },
    })
  }

  reportSpamGuardState(
    'degraded',
    'Spam Guard evaluation failed',
    'high',
    !wasDegraded
  )
}

export function createSpamGuard({
  scope = 'global',
  threshold = 120,
  windowSeconds = 60,
  skipPaths = [],
  failOpen = true,
  ipFallbackMultiplier = DEFAULT_IP_FALLBACK_MULTIPLIER,
} = {}) {
  const safeScope = cleanText(scope, 80) || 'global'
  const safeThreshold = Math.max(1, Number(threshold) || 120)
  const safeWindowSeconds = Math.max(
    1,
    Number(windowSeconds) || 60
  )
  const safeIpFallbackMultiplier = Math.max(
    2,
    Number(ipFallbackMultiplier)
      || DEFAULT_IP_FALLBACK_MULTIPLIER
  )

  reportSpamGuardState(
    'monitoring',
    'Spam Guard ready',
    'info'
  )

  return async function spamGuardMiddleware(req, res, next) {
    if (req.method === 'OPTIONS') return next()

    pruneRestrictions()

    const requestPath = cleanText(
      req.originalUrl || req.url || '/',
      500
    )

    if (shouldSkipPath(requestPath, skipPaths)) return next()

    const identity = buildGuardIdentity(req)

    if (!identity.guardKey) return next()

    if (canUseReaderCache(safeScope, req, identity)) return next()

    try {
      let effectiveScope = safeScope
      let effectiveGuardKey = identity.guardKey
      let effectiveIdentityType = identity.identityType

      let result = await evaluateGuard({
        guardKey: identity.guardKey,
        scope: safeScope,
        identity,
        requestPath,
        method: req.method,
        threshold: safeThreshold,
        windowSeconds: safeWindowSeconds,
      })

      if (
        result?.allowed !== false
        && canUseIpFallback(safeScope, identity)
      ) {
        const fallbackScope = `${safeScope}_ip_fallback`
        const fallbackGuardKey = `ip:${identity.ipAddress}`

        const fallbackResult = await evaluateGuard({
          guardKey: fallbackGuardKey,
          scope: fallbackScope,
          identity: {
            ...identity,
            accountId: '',
          },
          requestPath,
          method: req.method,
          threshold: Math.ceil(
            safeThreshold * safeIpFallbackMultiplier
          ),
          windowSeconds: safeWindowSeconds,
        })

        if (fallbackResult?.allowed === false) {
          result = fallbackResult
          effectiveScope = fallbackScope
          effectiveGuardKey = fallbackGuardKey
          effectiveIdentityType = 'ip_fallback'
        }
      }

      markHealthy()

      if (!result) return next()

      updateReaderCache(safeScope, req, identity, result, safeThreshold)

      req.spamGuard = buildGuardSnapshot({
        result,
        scope: effectiveScope,
        guardKey: effectiveGuardKey,
        identityType: effectiveIdentityType,
      })

      if (result.allowed !== false) return next()

      const resolved = resolveRestriction(result)

      recordRestriction({
        scope: effectiveScope,
        guardKey: effectiveGuardKey,
        identityType: effectiveIdentityType,
        requestPath,
        method: req.method,
        result,
        resolved,
      })

      res.setHeader(
        'Retry-After',
        String(resolved.retryAfter)
      )
      res.setHeader('X-Spam-Guard', resolved.header)
      res.setHeader(
        'X-Spam-Guard-Scope',
        effectiveScope
      )

      return res.status(429).json({
        ok: false,
        code: resolved.code,
        message: resolved.message,
        scope: effectiveScope,
        retry_after_seconds: resolved.retryAfter,
        cooldown_until: result.cooldown_until || null,
        quarantine_until: result.quarantine_until || null,
        restriction_until:
          result.quarantine_until
          || result.cooldown_until
          || null,
        block_status: resolved.status,
        offense_count: Number(result.offense_count || 0),
        spam_score: Number(result.spam_score || 0),
        reason:
          result.reason
          || 'Request limit exceeded',
      })
    } catch (error) {
      markDegraded(error, safeScope, requestPath)

      console.error('SPAM GUARD ERROR:', {
        scope: safeScope,
        path: requestPath,
        message: error?.message || error,
      })

      if (failOpen) return next()

      return res.status(503).json({
        ok: false,
        code: 'SPAM_GUARD_UNAVAILABLE',
        message:
          'Request protection is temporarily unavailable.',
      })
    }
  }
}
