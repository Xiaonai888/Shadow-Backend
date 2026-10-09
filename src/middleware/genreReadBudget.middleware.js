import jwt from 'jsonwebtoken'
import { isIP } from 'node:net'
import { GENRE_PAGE_SIZE } from '../services/publicGenrePagination.service.js'

const MINUTE_MS = 60 * 1000
const FIVE_MINUTES_MS = 5 * MINUTE_MS
const MAX_PER_MINUTE = 120
const MAX_PER_FIVE_MINUTES = 450
const COOLDOWNS_MS = [30000, 120000, 300000]
const OFFENSE_RESET_MS = 15 * MINUTE_MS
const MAX_IDENTITIES = 20000
const activity = new Map()

function getIp(req) {
  const values = [
    req.headers['cf-connecting-ip'],
    req.headers['true-client-ip'],
    req.ip,
    req.socket?.remoteAddress,
  ]

  for (const value of values) {
    const candidate = String(value || '').trim().replace(/^::ffff:/, '')
    if (isIP(candidate)) return candidate
  }

  return 'unknown'
}

function getAccountId(req) {
  const header = String(req.headers.authorization || '')
  if (!header.startsWith('Bearer ') || !process.env.JWT_SECRET) return ''

  try {
    const token = header.slice(7)
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    if (decoded?.type !== 'reader') return ''
    return String(decoded.user_id || decoded.id || '').trim().slice(0, 128)
  } catch {
    return ''
  }
}

function getIdentity(req) {
  const accountId = getAccountId(req)
  return accountId ? `account:${accountId}` : `ip:${getIp(req)}`
}

function getState(key, now) {
  let state = activity.get(key)

  if (!state) {
    if (activity.size >= MAX_IDENTITIES) {
      const oldest = activity.keys().next().value
      if (oldest !== undefined) activity.delete(oldest)
    }

    state = { hits: [], strikes: 0, lastStrike: 0, blockedUntil: 0 }
    activity.set(key, state)
  }

  state.hits = state.hits.filter((time) => now - time < FIVE_MINUTES_MS)

  if (state.lastStrike && now - state.lastStrike >= OFFENSE_RESET_MS) {
    state.strikes = 0
    state.lastStrike = 0
  }

  activity.delete(key)
  activity.set(key, state)
  return state
}

function timeUntilAvailable(hits, now, windowMs, maxStories) {
  const recent = hits.filter((time) => now - time < windowMs)
  const excess = recent.length * GENRE_PAGE_SIZE + GENRE_PAGE_SIZE - maxStories
  if (excess <= 0) return 0

  const requiredExpirations = Math.ceil(excess / GENRE_PAGE_SIZE)
  return Math.max(1, recent[requiredExpirations - 1] + windowMs - now)
}

function rejectWithCooldown(res, remainingMs, state) {
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000))
  res.setHeader('Retry-After', String(seconds))
  res.setHeader('Cache-Control', 'no-store')

  return res.status(429).json({
    ok: false,
    code: 'GENRE_LOAD_COOLDOWN',
    message: 'Please wait before loading more stories.',
    retry_after_seconds: seconds,
    cooldown_until: new Date(Date.now() + remainingMs).toISOString(),
    offense_count: state.strikes,
  })
}

export function limitGenreReadBudget(req, res, next) {
  if (String(req.query.genre_pagination || '') !== '1') return next()

  const now = Date.now()
  const state = getState(getIdentity(req), now)

  if (state.blockedUntil > now) {
    return rejectWithCooldown(res, state.blockedUntil - now, state)
  }

  const oneMinuteWait = timeUntilAvailable(state.hits, now, MINUTE_MS, MAX_PER_MINUTE)
  const fiveMinuteWait = timeUntilAvailable(state.hits, now, FIVE_MINUTES_MS, MAX_PER_FIVE_MINUTES)

  if (oneMinuteWait || fiveMinuteWait) {
    state.strikes += 1
    state.lastStrike = now
    const cooldown = COOLDOWNS_MS[Math.min(state.strikes - 1, COOLDOWNS_MS.length - 1)]
    state.blockedUntil = now + Math.max(cooldown, oneMinuteWait, fiveMinuteWait)
    return rejectWithCooldown(res, state.blockedUntil - now, state)
  }

  state.hits.push(now)
  return next()
}

setInterval(() => {
  const now = Date.now()
  for (const [key, state] of activity) {
    if (state.blockedUntil <= now &&
        now - (state.hits[state.hits.length - 1] || 0) > FIVE_MINUTES_MS &&
        now - state.lastStrike > OFFENSE_RESET_MS) {
      activity.delete(key)
    }
  }
}, MINUTE_MS).unref()
