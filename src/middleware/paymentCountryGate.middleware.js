import jwt from 'jsonwebtoken'
import { supabase } from '../config/supabase.js'
import { isReaderClassificationCountryPolicyEnabled } from '../services/readerClassificationCountrySource.service.js'

const ISSUER = 'shadow-country-settings'
const AUDIENCE = 'shadow-payment-creation'
const INVALID_COUNTRIES = new Set(['XX', 'ZZ', 'T1'])
const PAYMENT_FEATURES = new Set(['payway', 'binancePay'])

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

export function requirePaymentCountry(feature) {
  if (!PAYMENT_FEATURES.has(feature)) throw new Error('Unsupported payment feature')

  return async function paymentCountryGuard(req, res, next) {
    if (!isReaderClassificationCountryPolicyEnabled()) return next()
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

      if (settings.rules?.[region]?.[feature] !== true) {
        return deny(res, 'PAYMENT_METHOD_UNAVAILABLE', 'This payment method is not available in your country')
      }

      const { data: exception, error: exceptionError } = await supabase
        .from('shadow_country_user_exceptions')
        .select('mode,overrides,expires_at')
        .eq('user_id', req.user.user_id)
        .maybeSingle()

      if (exceptionError) throw exceptionError

      const isActive = exception && (!exception.expires_at || Date.parse(exception.expires_at) > Date.now())
      if (isActive && exception.mode === 'custom' && exception.overrides?.[feature] === 'block') {
        return deny(res, 'PAYMENT_METHOD_UNAVAILABLE', 'This payment method is disabled for your account')
      }

      return next()
    } catch (error) {
      console.error('PAYMENT COUNTRY GATE ERROR:', error?.message || error)
      return deny(res, 'COUNTRY_GATE_UNAVAILABLE', 'Could not verify payment country settings', 503)
    }
  }
}
