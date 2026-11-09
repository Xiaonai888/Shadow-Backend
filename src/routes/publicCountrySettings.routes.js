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
const PAYOUT_FLAGS = ['payoutBank', 'payoutBinance', 'payoutPhone']
const SCOPED_PAYMENT_FLAGS = ['premiumPayway', 'premiumBinancePay', 'pdfPayway', 'pdfBinancePay']
const NEW_FLAGS = ['shadowMall', 'readerMall', ...PAYOUT_FLAGS, ...SCOPED_PAYMENT_FLAGS]
// Future Country Rules switches are automatically eligible for per-user overrides.
const EXTRA_BOOLEAN_KEY = /^[a-z][a-zA-Z0-9_]{0,63}$/
const MAX_RULE_KEYS = 64
const FALLBACK_RULES = {
  kh: {
    app: true,
    physicalBooks: true,
    binancePay: false,
    payway: false,
    premiumPayway: false,
    premiumBinancePay: false,
    pdfPayway: false,
    pdfBinancePay: false,
    shadowMall: true,
    readerMall: true,
    payoutBank: true,
    payoutBinance: false,
    payoutPhone: true,
    storyLanguage: 'km',
    shopTarget: 'shadow_mall',
  },
  international: {
    app: true,
    physicalBooks: true,
    binancePay: false,
    payway: false,
    premiumPayway: false,
    premiumBinancePay: false,
    pdfPayway: false,
    pdfBinancePay: false,
    shadowMall: false,
    readerMall: true,
    payoutBank: false,
    payoutBinance: false,
    payoutPhone: true,
    storyLanguage: 'en',
    shopTarget: 'diamonds',
  },
}
let cached = null
let expiresAt = 0
let pending = null

function validRule(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
  if (Object.keys(entry).length > MAX_RULE_KEYS) return false
  return LEGACY_FLAGS.every(key => typeof entry[key] === 'boolean')
    && LANGUAGES.has(entry.storyLanguage)
    && TARGETS.has(entry.shopTarget)
    && Object.entries(entry).every(([key, value]) => {
      if (key === 'storyLanguage') return LANGUAGES.has(value)
      if (key === 'shopTarget') return TARGETS.has(value)
      return EXTRA_BOOLEAN_KEY.test(key) && typeof value === 'boolean'
    })
}

function normalizeRegionRule(entry, region) {
  return {
    ...entry,
    // Fill missing keys in legacy settings without changing saved policy.
    premiumPayway: typeof entry.premiumPayway === 'boolean' ? entry.premiumPayway : entry.payway,
    premiumBinancePay: typeof entry.premiumBinancePay === 'boolean' ? entry.premiumBinancePay : false,
    pdfPayway: typeof entry.pdfPayway === 'boolean' ? entry.pdfPayway : entry.payway,
    pdfBinancePay: typeof entry.pdfBinancePay === 'boolean' ? entry.pdfBinancePay : false,
    shadowMall: typeof entry.shadowMall === 'boolean' ? entry.shadowMall : region === 'kh',
    readerMall: typeof entry.readerMall === 'boolean' ? entry.readerMall : region === 'kh',
    payoutBank: typeof entry.payoutBank === 'boolean' ? entry.payoutBank : region === 'kh',
    payoutBinance: typeof entry.payoutBinance === 'boolean' ? entry.payoutBinance : false,
    payoutPhone: typeof entry.payoutPhone === 'boolean' ? entry.payoutPhone : true,
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
    const normalized = {
      kh: normalizeRegionRule(data.rules.kh, 'kh'),
      international: normalizeRegionRule(data.rules.international, 'international'),
    }
    // Both regions must define every new boolean key; avoid silent fallback.
    if (JSON.stringify(Object.keys(normalized.kh).sort()) !==
        JSON.stringify(Object.keys(normalized.international).sort())) {
      throw new Error('Country rule feature lists differ by region')
    }
    cached = {
      rules: normalized,
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

// Binance alone uses the saved-country rules during the general policy pause.
// Match requireBinanceSavedCountry in paymentCountryGate.middleware.js.
function resolveScopedPaymentDuringPause(rules, region, countryAvailable, exception, feature) {
  if (!countryAvailable || !['kh', 'international'].includes(region)) return false
  const baseline = exception?.mode === 'cambodia_experience' ? 'kh' : region
  let allowed = rules?.[baseline]?.[feature] === true
  if (exception?.mode === 'all_eligible') allowed = true
  if (exception?.mode === 'custom') {
    if (exception.overrides?.[feature] === 'allow') allowed = true
    if (exception.overrides?.[feature] === 'block') allowed = false
  }
  return allowed
}

function resolveRules(rules, region, countryAvailable, exception, policyEnabled) {
  if (!policyEnabled) {
    const baseline = exception?.mode === 'cambodia_experience' ? 'kh' : region
    const regionGame = rules[baseline === 'international' ? 'international' : 'kh']?.game
    const shopTarget = exception?.mode === 'custom' && TARGETS.has(exception.overrides?.shopTarget)
      ? exception.overrides.shopTarget
      : rules.kh.shopTarget
    let shopEnabled = rules.kh.shadowMall === true
    if (exception?.mode === 'all_eligible') shopEnabled = true
    if (exception?.mode === 'custom') {
      if (exception.overrides?.shadowMall === 'allow') shopEnabled = true
      if (exception.overrides?.shadowMall === 'block') shopEnabled = false
    }
    const shopAllowed = countryAvailable && region === 'kh' && shopEnabled && shopTarget === 'shadow_mall'
    let gameAllowed = countryAvailable && typeof regionGame === 'boolean' ? regionGame : true

    if (countryAvailable && exception?.mode === 'all_eligible') {
      gameAllowed = true
    }

    if (countryAvailable && exception?.mode === 'custom') {
      if (exception.overrides?.game === 'allow') gameAllowed = true
      if (exception.overrides?.game === 'block') gameAllowed = false
    }

    return {
      ...rules[region === 'international' ? 'international' : 'kh'],
      app: true,
      game: gameAllowed,
      physicalBooks: true,
      shadowMall: shopAllowed,
      readerMall: true,
      payway: true,
      binancePay: resolveScopedPaymentDuringPause(rules, region, countryAvailable, exception, 'binancePay'),
      premiumPayway: resolveScopedPaymentDuringPause(rules, region, countryAvailable, exception, 'premiumPayway'),
      premiumBinancePay: resolveScopedPaymentDuringPause(rules, region, countryAvailable, exception, 'premiumBinancePay'),
      pdfPayway: resolveScopedPaymentDuringPause(rules, region, countryAvailable, exception, 'pdfPayway'),
      pdfBinancePay: resolveScopedPaymentDuringPause(rules, region, countryAvailable, exception, 'pdfBinancePay'),
      shopTarget: shopAllowed ? 'shadow_mall' : 'diamonds',
    }
  }
  // Country Rules supply defaults; explicit User Exceptions take precedence.
  const baseline = exception?.mode === 'cambodia_experience' ? 'kh' : region
  const effective = { ...rules[baseline === 'kh' ? 'kh' : 'international'] }
  if (!countryAvailable && exception?.mode !== 'cambodia_experience') {
    // Preserve the existing cautious defaults when the saved country is unknown.
    Object.assign(effective, {
      app: true,
      physicalBooks: false,
      shadowMall: false,
      readerMall: false,
      payway: false,
      binancePay: false,
      premiumPayway: false,
      premiumBinancePay: false,
      pdfPayway: false,
      pdfBinancePay: false,
      shopTarget: 'diamonds',
    })
    // New features should not be enabled for unknown countries unless both
    // regional rules enable them or a valid User Exception explicitly allows.
    for (const key of Object.keys(effective)) {
      if (typeof effective[key] !== 'boolean' || LEGACY_FLAGS.includes(key) ||
          NEW_FLAGS.includes(key)) continue
      effective[key] = rules.kh[key] === true && rules.international[key] === true
    }
  }
  if (exception?.mode === 'all_eligible') {
    for (const key of Object.keys(effective)) {
      if (typeof effective[key] === 'boolean') effective[key] = true
    }
  }
  if (exception?.mode === 'custom' && exception.overrides && typeof exception.overrides === 'object') {
    for (const [key, value] of Object.entries(exception.overrides)) {
      if (!Object.hasOwn(effective, key) || !Object.hasOwn(rules.kh, key) ||
          !Object.hasOwn(rules.international, key) ||
          typeof effective[key] !== 'boolean') continue
      if (value === 'allow') effective[key] = true
      if (value === 'block') effective[key] = false
    }
    if (LANGUAGES.has(exception.overrides.storyLanguage)) effective.storyLanguage = exception.overrides.storyLanguage
    if (TARGETS.has(exception.overrides.shopTarget)) effective.shopTarget = exception.overrides.shopTarget
  }
  // A verified saved country is mandatory for scoped payment methods.
  // Do not advertise methods that the backend will reject.
  if (!countryAvailable) {
    effective.binancePay = false
    for (const key of SCOPED_PAYMENT_FLAGS) effective[key] = false
  }
  const shopAllowed = countryAvailable && region === 'kh' &&
    effective.shadowMall === true && effective.shopTarget === 'shadow_mall'
  effective.shadowMall = shopAllowed
  effective.shopTarget = shopAllowed ? 'shadow_mall' : 'diamonds'
  return effective
}

router.use(createRateLimit({
  key: 'public-country-settings',
  windowMs: 60000,
  max: 600,
  identity: req => req.ip,
}))

function resolvePayoutMethods(rules, region, exception) {
  const baseline = exception?.mode === 'cambodia_experience' ? 'kh' : region
  const effective = region === 'unknown'
    ? { payoutBank: true, payoutBinance: false, payoutPhone: true }
    : Object.fromEntries(PAYOUT_FLAGS.map(key => [key, rules[baseline][key]]))
  if (exception?.mode === 'custom' && exception.overrides && typeof exception.overrides === 'object') {
    for (const key of PAYOUT_FLAGS) {
      if (exception.overrides[key] === 'allow') effective[key] = true
      if (exception.overrides[key] === 'block') effective[key] = false
    }
  }
  return {
    bank_qr: effective.payoutBank === true,
    binance: effective.payoutBinance === true,
    phone: effective.payoutPhone === true,
  }
}

router.get('/payout', requireUser, async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  res.set('Vary', 'Authorization')
  try {
    const userId = req.user?.user_id
    const policyEnabled = isReaderClassificationCountryPolicyEnabled()
    const [settings, savedCountry, exception] = await Promise.all([
      policyEnabled ? getRules() : Promise.resolve(null),
      readReaderClassificationCountry(userId),
      policyEnabled ? getException(userId) : Promise.resolve(null),
    ])
    const country = savedCountry?.verified === true ? savedCountry.country : null
    const region = country === null ? 'unknown' : country === 'KH' ? 'kh' : 'international'
    return res.json({
      ok: true,
      country: country || 'unknown',
      region,
      countryVerified: Boolean(country),
      // No country restrictions until the shared policy switch is enabled.
      // Keep the not-yet-launched Binance payout option hidden.
      payoutMethods: policyEnabled
        ? resolvePayoutMethods(settings.rules, region, exception)
        : { bank_qr: true, binance: false, phone: true },
      hasException: Boolean(exception),
      revision: settings?.revision || 0,
    })
  } catch (error) {
    console.error('PUBLIC PAYOUT SETTINGS ERROR:', error?.message || error)
    return res.status(503).json({ ok: false, message: 'Payout settings temporarily unavailable' })
  }
})

router.get('/', optionalReader, async (req, res) => {
  res.set('Cache-Control', 'private, no-store')
  res.set('Vary', 'Authorization')
  const userId = req.user?.user_id || null
  const sourceReady = isReaderClassificationCountryPolicyEnabled()
  const [savedCountry, settingsResult, exceptionResult] = await Promise.allSettled([
    userId ? readReaderClassificationCountry(userId) : Promise.resolve(null),
    getRules(),
    // Binance remains country-controlled while all other features are paused.
    userId ? getException(userId) : Promise.resolve(null),
  ])
  const country = savedCountry.status === 'fulfilled' && savedCountry.value?.verified === true
    ? savedCountry.value.country || null : null
  const region = country === null ? 'unknown' : country === 'KH' ? 'kh' : 'international'
  const settings = settingsResult.status === 'fulfilled'
    ? settingsResult.value
    : { rules: FALLBACK_RULES, revision: 0, ready: false }
  const exception = exceptionResult.status === 'fulfilled' ? exceptionResult.value : null
  const policyEnabled = Boolean(sourceReady && settings.ready)
  const effective = resolveRules(settings.rules, region, Boolean(country), exception, policyEnabled)
  // If the saved rule/exception could not be checked, do not advertise Binance.
  if (!settings.ready || (userId && exceptionResult.status !== 'fulfilled')) {
    effective.shadowMall = false
    effective.shopTarget = 'diamonds'
    effective.binancePay = false
    for (const key of SCOPED_PAYMENT_FLAGS) effective[key] = false
  }
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
