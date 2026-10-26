import express from 'express'
import { timingSafeEqual } from 'node:crypto'
import { supabase } from '../config/supabase.js'
import { requireUser } from '../middleware/user.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import { createPaymentCountryTicket } from '../middleware/paymentCountryGate.middleware.js'

const router = express.Router()
const TTL = 45000
const LANGUAGES = new Set(['km', 'en', 'zh', 'ja', 'ko'])
const TARGETS = new Set(['shadow_mall', 'diamonds'])
const LEGACY_FLAGS = ['app', 'physicalBooks', 'binancePay', 'payway']
const NEW_FLAGS = ['shadowMall', 'readerMall']
const FLAGS = [...LEGACY_FLAGS, ...NEW_FLAGS]
let cached = null
let expiresAt = 0
let pending = null

function readCountry(req) {
  const secret = process.env.SHADOW_GEO_PROXY_SECRET || ''
  const supplied = String(req.get('x-shadow-geo-secret') || '')
  if (secret.length < 32 || !supplied) return null
  const a = Buffer.from(secret)
  const b = Buffer.from(supplied)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  const country = String(req.get('x-shadow-geo-country') || '').trim().toUpperCase()
  return /^[A-Z]{2}$/.test(country) && !['XX', 'ZZ', 'T1'].includes(country) ? country : null
}

function validRule(entry) {
  return entry && typeof entry === 'object' && !Array.isArray(entry)
    && LEGACY_FLAGS.every(key => typeof entry[key] === 'boolean')
    && NEW_FLAGS.every(key => entry[key] === undefined || typeof entry[key] === 'boolean')
    && LANGUAGES.has(entry.storyLanguage)
    && TARGETS.has(entry.shopTarget)
}

function normalizeRegionRule(entry, region) {
  return {
    ...entry,
    shadowMall: typeof entry.shadowMall === 'boolean' ? entry.shadowMall : region === 'kh',
    readerMall: typeof entry.readerMall === 'boolean' ? entry.readerMall : region === 'kh',
  }
}

async function getRules() {
  if (cached && Date.now() < expiresAt) return cached
  if (pending) return pending
  pending = (async () => {
    const { data, error } = await supabase.from('shadow_country_settings')
      .select('rules,revision').eq('settings_key', 'default').single()
    if (error) throw error
    if (!validRule(data?.rules?.kh) || !validRule(data?.rules?.international)) {
      throw new Error('Invalid country rule configuration')
    }
    cached = {
      rules: {
        kh: normalizeRegionRule(data.rules.kh, 'kh'),
        international: normalizeRegionRule(data.rules.international, 'international'),
      },
      revision: data.revision,
    }
    expiresAt = Date.now() + TTL
    return cached
  })()
  try {
    return await pending
  } finally {
    pending = null
  }
}

function optionalReader(req, res, next) {
  const authorization = String(req.get('authorization') || '')
  if (!authorization) return next()
  return requireUser(req, res, next)
}

async function getException(userId) {
  if (!userId) return null
  const { data, error } = await supabase.from('shadow_country_user_exceptions')
    .select('mode,overrides,expires_at').eq('user_id', userId).maybeSingle()
  if (error) throw error
  if (!data || (data.expires_at && Date.parse(data.expires_at) <= Date.now())) return null
  return data
}

function resolveRules(rules, region, countryVerified, exception) {
  if (region === 'unknown' && !exception) return null
  const baseline = exception?.mode === 'cambodia_experience' ? 'kh' : region
  const effective = { ...rules[baseline === 'kh' ? 'kh' : 'international'] }
  effective.binancePay = countryVerified ? rules[region].binancePay : true
  effective.payway = countryVerified ? rules[region].payway : true
  if (exception?.mode === 'all_eligible') {
    effective.app = true
    effective.shadowMall = true
    effective.readerMall = true
  }
  if (exception?.mode === 'custom' && exception.overrides && typeof exception.overrides === 'object') {
    for (const key of FLAGS) {
      const value = exception.overrides[key]
      if (value === 'allow') effective[key] = true
      if (value === 'block') effective[key] = false
    }
    if (LANGUAGES.has(exception.overrides.storyLanguage)) effective.storyLanguage = exception.overrides.storyLanguage
    if (TARGETS.has(exception.overrides.shopTarget)) effective.shopTarget = exception.overrides.shopTarget
  }
  effective.payway = Boolean(countryVerified && rules[region]?.payway === true && effective.payway)
  effective.binancePay = Boolean(countryVerified && rules[region]?.binancePay === true && effective.binancePay)
  effective.physicalBooks = Boolean(countryVerified && region === 'kh' && rules.kh.physicalBooks === true && effective.physicalBooks)
  return effective
}

router.use(createRateLimit({
  key: 'public-country-settings',
  windowMs: 60000,
  max: 600,
  identity: req => req.ip,
}))

router.get('/', optionalReader, async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  res.set('Vary', 'Authorization')
  try {
    const country = readCountry(req)
    const region = country === null ? 'unknown' : country === 'KH' ? 'kh' : 'international'
    const userId = req.user?.user_id || null
    const [settings, exception] = await Promise.all([getRules(), getException(userId)])
    const effective = resolveRules(settings.rules, region, Boolean(country), exception)
    return res.json({
      ok: true,
      country: country || 'unknown',
      region,
      countryVerified: Boolean(country),
      effective,
      hasException: Boolean(exception),
      revision: settings.revision,
      paymentCountryTicket: country && userId && req.user?.session_id
        ? createPaymentCountryTicket({
            userId,
            sessionId: req.user.session_id,
            country,
            revision: settings.revision,
          })
        : null,
    })
  } catch (error) {
    console.error('PUBLIC COUNTRY SETTINGS ERROR:', error)
    return res.status(503).json({ ok: false, message: 'Country settings temporarily unavailable' })
  }
})

export default router
