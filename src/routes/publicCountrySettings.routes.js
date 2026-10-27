import express from 'express'
import { supabase } from '../config/supabase.js'
import { requireUser } from '../middleware/user.middleware.js'
import { createRateLimit } from '../middleware/rateLimit.middleware.js'
import { createPaymentCountryTicket } from '../middleware/paymentCountryGate.middleware.js'
import { isReaderClassificationCountryPolicyEnabled, readReaderClassificationCountry } from '../services/readerClassificationCountrySource.service.js'

const router = express.Router()
const TTL = 45000
const LANGUAGES = new Set(['km', 'en', 'zh', 'ja', 'ko'])
const TARGETS = new Set(['shadow_mall', 'diamonds'])
const LEGACY_FLAGS = ['app', 'physicalBooks', 'binancePay', 'payway']
const NEW_FLAGS = ['shadowMall', 'readerMall']
const FLAGS = [...LEGACY_FLAGS, ...NEW_FLAGS]
const FALLBACK_RULES = {
  kh: {
    app: true,
    physicalBooks: true,
    binancePay: false,
    payway: false,
    shadowMall: true,
    readerMall: true,
    storyLanguage: 'km',
    shopTarget: 'shadow_mall',
  },
  international: {
    app: true,
    physicalBooks: true,
    binancePay: false,
    payway: false,
    shadowMall: true,
    readerMall: true,
    storyLanguage: 'en',
    shopTarget: 'shadow_mall',
  },
}
let cached = null
let expiresAt = 0
let pending = null

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
      ready: true,
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

function resolveRules(rules, region, countryAvailable, exception, policyEnabled) {
  if (!policyEnabled) {
    return {
      ...rules[region === 'international' ? 'international' : 'kh'],
      app: true,
      physicalBooks: true,
      shadowMall: true,
      readerMall: true,
      payway: true,
      binancePay: true,
      shopTarget: 'shadow_mall',
    }
  }
  if (!countryAvailable) {
    return {
      ...rules.international,
      app: true,
      physicalBooks: false,
      shadowMall: false,
      readerMall: false,
      payway: false,
      binancePay: false,
      shopTarget: 'diamonds',
    }
  }
  const baseline = exception?.mode === 'cambodia_experience' ? 'kh' : region
  const effective = { ...rules[baseline === 'kh' ? 'kh' : 'international'] }
  if (exception?.mode === 'all_eligible') effective.app = true
  if (exception?.mode === 'custom' && exception.overrides && typeof exception.overrides === 'object') {
    for (const key of FLAGS) {
      if (exception.overrides[key] === 'allow') effective[key] = true
      if (exception.overrides[key] === 'block') effective[key] = false
    }
    if (LANGUAGES.has(exception.overrides.storyLanguage)) effective.storyLanguage = exception.overrides.storyLanguage
    if (TARGETS.has(exception.overrides.shopTarget)) effective.shopTarget = exception.overrides.shopTarget
  }
  effective.physicalBooks = Boolean(region === 'kh' && rules.kh.physicalBooks && effective.physicalBooks)
  effective.payway = Boolean(rules[region]?.payway && effective.payway)
  effective.binancePay = Boolean(rules[region]?.binancePay && effective.binancePay)
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
  const userId = req.user?.user_id || null
  const sourceReady = isReaderClassificationCountryPolicyEnabled()
  const [savedCountry, settingsResult, exceptionResult] = await Promise.allSettled([
    userId ? readReaderClassificationCountry(userId) : Promise.resolve(null),
    getRules(),
    sourceReady ? getException(userId) : Promise.resolve(null),
  ])
  const country = savedCountry.status === 'fulfilled' ? savedCountry.value?.country || null : null
  const region = country === null ? 'unknown' : country === 'KH' ? 'kh' : 'international'
  const settings = settingsResult.status === 'fulfilled'
    ? settingsResult.value
    : { rules: FALLBACK_RULES, revision: 0, ready: false }
  const exception = exceptionResult.status === 'fulfilled' ? exceptionResult.value : null
  const policyEnabled = Boolean(sourceReady && settings.ready)
  const effective = resolveRules(settings.rules, region, Boolean(country), exception, policyEnabled)
  const canCreateTicket = Boolean(policyEnabled && country && userId && req.user?.session_id)
  if (settingsResult.status === 'rejected') {
    console.error('PUBLIC COUNTRY RULES ERROR:', settingsResult.reason)
  }
  if (savedCountry.status === 'rejected') {
    console.error('PUBLIC SAVED COUNTRY ERROR:', savedCountry.reason)
  }
  if (exceptionResult.status === 'rejected') {
    console.error('PUBLIC COUNTRY EXCEPTION ERROR:', exceptionResult.reason)
  }
  return res.json({
    ok: true,
    country: country || 'unknown',
    region,
    countryVerified: Boolean(country),
    countryPolicyEnabled: policyEnabled,
    countrySource: 'reader_classification',
    effective,
    hasException: Boolean(exception),
    revision: settings.revision,
    paymentCountryTicket: canCreateTicket
      ? createPaymentCountryTicket({
          userId,
          sessionId: req.user.session_id,
          country,
          revision: settings.revision,
        })
      : null,
  })
})

export default router
