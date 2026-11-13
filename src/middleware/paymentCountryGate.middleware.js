import jwt from 'jsonwebtoken'
import { supabase } from '../config/supabase.js'
import { isReaderClassificationCountryPolicyEnabled, readReaderClassificationCountry } from '../services/readerClassificationCountrySource.service.js'

const ISSUER = 'shadow-country-settings'
const AUDIENCE = 'shadow-payment-creation'
const INVALID_COUNTRIES = new Set(['XX', 'ZZ', 'T1'])
const SCOPED_PAYMENT_FEATURES = new Set(['premiumPayway', 'premiumBinancePay', 'pdfPayway', 'pdfBinancePay', 'readerPaymentBinance'])
const COUNTRY_CONTROLLED_DURING_PAUSE = new Set(['binancePay', ...SCOPED_PAYMENT_FEATURES])
const PAYMENT_FEATURES = new Set(['payway', 'binancePay', ...SCOPED_PAYMENT_FEATURES])

function isPaymentFeatureEnabled(rule, feature) {
  if (typeof rule?.[feature] === 'boolean') return rule[feature]
  // Legacy saved country settings predate these four switches.
  // Existing ABA defaults are retained; Binance is fail-closed until enabled.
  if (feature === 'premiumPayway' || feature === 'pdfPayway') return rule?.payway === true
  if (feature === 'premiumBinancePay' || feature === 'pdfBinancePay') return false
  return false
}

function validCountry(value) {
  return typeof value === 'string' && /^[A-Z]{2}$/.test(value) && !INVALID_COUNTRIES.has(value)
}

function signingSecret() {
  const secret = process.env.SHADOW_GEO_PROXY_SECRET || ''
  return secret.length >= 32 ? secret : null
}

export function createPaymentCountryTicket({ userId, sessionId, country, revision }) {
  const secret = signingSecret()
  if (!secret || !userId || !sessionId || !validCountry(country) || !Number.isSafeInteger(Number(revision))) return null

  return jwt.sign(
    { purpose: 'country_payment', sessionId: String(sessionId), country, revision: String(revision) },
    secret,
    {
      algorithm: 'HS256',
      issuer: ISSUER,
      audience: AUDIENCE,
      subject: String(userId),
      expiresIn: '10m',
    },
  )
}

function deny(res, code, message, status = 403) {
  return res.status(status).json({ ok: false, code, message })
}

// Legacy Diamonds ABA remains paused as before. Binance and scoped purchase
// methods use saved Admin Country Rules even while the broader policy is paused.
// The authenticated reader's saved country, not a request header, is authoritative.
async function requireSavedPaymentCountry(req, res, next, feature) {
  const userId = req.user?.user_id
  if (!userId) return deny(res, 'UNAUTHORIZED', 'Sign in to continue', 401)

  try {
    const savedCountry = await readReaderClassificationCountry(userId)
    if (!savedCountry?.verified || !validCountry(savedCountry.country)) {
      return deny(res, 'PAYMENT_COUNTRY_REQUIRED', 'Set a verified country before using Binance Pay')
    }

    const [{ data: settings, error: settingsError }, { data: exception, error: exceptionError }] = await Promise.all([
      supabase.from('shadow_country_settings')
        .select('rules').eq('settings_key', 'default').single(),
      supabase.from('shadow_country_user_exceptions')
        .select('mode,overrides,expires_at').eq('user_id', userId).maybeSingle(),
    ])
    if (settingsError || exceptionError || !settings?.rules ||
        typeof settings.rules.kh?.binancePay !== 'boolean' ||
        typeof settings.rules.international?.binancePay !== 'boolean' ||
        (typeof settings.rules.kh?.[feature] !== 'boolean' && !SCOPED_PAYMENT_FEATURES.has(feature)) ||
        (typeof settings.rules.international?.[feature] !== 'boolean' && !SCOPED_PAYMENT_FEATURES.has(feature))) {
      throw settingsError || exceptionError || new Error('Binance country rules missing')
    }

    const region = savedCountry.country === 'KH' ? 'kh' : 'international'
    const activeException = exception &&
      (!exception.expires_at || Date.parse(exception.expires_at) > Date.now())
      ? exception : null
    const selectedRegion = activeException?.mode === 'cambodia_experience' ? 'kh' : region
    let allowed = isPaymentFeatureEnabled(settings.rules[selectedRegion], feature)
    if (activeException?.mode === 'all_eligible') allowed = true
    if (activeException?.mode === 'custom') {
      if (activeException.overrides?.[feature] === 'allow') allowed = true
      if (activeException.overrides?.[feature] === 'block') allowed = false
    }

    if (!allowed) {
      return deny(res, 'PAYMENT_METHOD_UNAVAILABLE', 'This payment method is not available for your account')
    }
    return next()
  } catch (error) {
    console.error('PAYMENT COUNTRY RULE GATE ERROR:', String(error?.message || error).slice(0, 180))
    return deny(res, 'COUNTRY_GATE_UNAVAILABLE', 'Could not verify Binance country permission', 503)
  }
}

export function requireReaderPaymentBinanceProfile(req, res, next) {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
  if (!Object.hasOwn(body, 'binance_name') && !Object.hasOwn(body, 'binance_uid')) return next()
  return requireSavedPaymentCountry(req, res, next, 'readerPaymentBinance')
}

export function requirePaymentCountry(feature) {
  if (!PAYMENT_FEATURES.has(feature)) throw new Error('Unsupported payment feature')

  return async function paymentCountryGuard(req, res, next) {
    if (!isReaderClassificationCountryPolicyEnabled()) {
      // Existing Diamonds ABA stays as-is, but every new Premium/PDF method
      // gets its own saved-country rule (even while the broad policy is paused).
      return COUNTRY_CONTROLLED_DURING_PAUSE.has(feature)
        ? requireSavedPaymentCountry(req, res, next, feature) : next()
    }

    const secret = signingSecret()
    if (!secret) {
      return deny(res, 'COUNTRY_GATE_UNAVAILABLE', 'Payment country verification is not configured', 503)
    }

    const ticket = req.get('x-shadow-country-ticket')
    if (!ticket || ticket.length > 4096) {
      return deny(res, 'PAYMENT_COUNTRY_REQUIRED', 'Verify your country before creating a payment')
    }

    let claim
    try {
      claim = jwt.verify(ticket, secret, {
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: AUDIENCE,
      })
    } catch {
      return deny(res, 'PAYMENT_COUNTRY_INVALID', 'Country verification has expired or is invalid')
    }

    if (
      !claim ||
      claim.purpose !== 'country_payment' ||
      claim.sub !== String(req.user?.user_id || '') ||
      claim.sessionId !== String(req.user?.session_id || '') ||
      !validCountry(claim.country)
    ) {
      return deny(res, 'PAYMENT_COUNTRY_INVALID', 'Country verification does not match your session')
    }

    const region = claim.country === 'KH' ? 'kh' : 'international'

    try {
      const savedCountry = await readReaderClassificationCountry(req.user.user_id)
      if (!savedCountry?.verified || !validCountry(savedCountry.country) || savedCountry.country !== claim.country) {
        return deny(res, 'PAYMENT_COUNTRY_REFRESH_REQUIRED', 'Your saved country has changed or is unavailable. Refresh and retry.', 409)
      }

      const { data: settings, error: settingsError } = await supabase
        .from('shadow_country_settings')
        .select('rules,revision')
        .eq('settings_key', 'default')
        .single()

      if (settingsError || !settings || !Number.isSafeInteger(Number(settings.revision))) {
        throw settingsError || new Error('Country payment settings missing')
      }

      if (String(settings.revision) !== String(claim.revision)) {
        return deny(res, 'PAYMENT_COUNTRY_REFRESH_REQUIRED', 'Country settings have changed. Please retry.', 409)
      }

      const { data: exception, error: exceptionError } = await supabase
        .from('shadow_country_user_exceptions')
        .select('mode,overrides,expires_at')
        .eq('user_id', req.user.user_id)
        .maybeSingle()

      if (exceptionError) throw exceptionError

      // Match Public Country Settings: only active user exceptions can override.
      const activeException = exception &&
        (!exception.expires_at || Date.parse(exception.expires_at) > Date.now())
        ? exception : null
      const effectiveRegion = activeException?.mode === 'cambodia_experience' ? 'kh' : region
      let permitted = isPaymentFeatureEnabled(settings.rules?.[effectiveRegion], feature)
      if (activeException?.mode === 'all_eligible') permitted = true

      if (activeException?.mode === 'custom') {
        if (activeException.overrides?.[feature] === 'allow') permitted = true
        if (activeException.overrides?.[feature] === 'block') permitted = false
      }

      if (!permitted) {
        return deny(res, 'PAYMENT_METHOD_UNAVAILABLE', 'This payment method is not available for your account')
      }

      return next()
    } catch (error) {
      console.error('PAYMENT COUNTRY GATE ERROR:', error?.message || error)
      return deny(res, 'COUNTRY_GATE_UNAVAILABLE', 'Could not verify payment country settings', 503)
    }
  }
}
