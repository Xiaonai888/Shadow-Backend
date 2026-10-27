import jwt from 'jsonwebtoken'
import { supabase } from '../config/supabase.js'
import { isReaderClassificationCountryPolicyEnabled, readReaderClassificationCountry } from '../services/readerClassificationCountrySource.service.js'

const ISSUER = 'shadow-country-settings'
const AUDIENCE = 'shadow-payment-creation'

function fail(res, status, code, message) {
  return res.status(status).json({ ok: false, code, message })
}

export async function requireCambodiaPhysicalBooks(req, res, next) {
  if (!isReaderClassificationCountryPolicyEnabled()) return next()
  const userId = String(req.user?.user_id || req.user?.id || '')
  const sessionId = String(req.user?.session_id || '')
  if (!userId || !sessionId) {
    return fail(res, 401, 'BOOK_COUNTRY_LOGIN_REQUIRED', 'Sign in to verify physical book availability')
  }

  const secret = String(process.env.SHADOW_GEO_PROXY_SECRET || '')
  if (secret.length < 32) {
    return fail(res, 503, 'BOOK_COUNTRY_UNAVAILABLE', 'Book region verification is unavailable')
  }

  const ticket = String(req.get('x-shadow-country-ticket') || '')
  if (!ticket || ticket.length > 4096) {
    return fail(res, 403, 'BOOK_COUNTRY_REQUIRED', 'Verify your country before buying physical books')
  }

  let claims
  try {
    claims = jwt.verify(ticket, secret, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    })
  } catch {
    return fail(res, 403, 'BOOK_COUNTRY_INVALID', 'Country verification is invalid or has expired')
  }

  if (
    !claims ||
    claims.purpose !== 'country_payment' ||
    claims.country !== 'KH' ||
    claims.sub !== userId ||
    claims.sessionId !== sessionId ||
    !/^(0|[1-9][0-9]*)$/.test(String(claims.revision || ''))
  ) {
    return fail(res, 403, 'BOOK_COUNTRY_BLOCKED', 'Physical books are available only in Cambodia')
  }

  try {
    const [settingsResult, exceptionResult, currentCountry] = await Promise.all([
      supabase
        .from('shadow_country_settings')
        .select('rules,revision')
        .eq('settings_key', 'default')
        .single(),
      supabase
        .from('shadow_country_user_exceptions')
        .select('mode,overrides,expires_at')
        .eq('user_id', userId)
        .maybeSingle(),
      readReaderClassificationCountry(userId),
    ])

    // A previously signed KH ticket must not bypass a later Admin country override.
    if (currentCountry?.verified !== true || currentCountry.country !== 'KH') {
      return fail(res, 409, 'BOOK_COUNTRY_REFRESH_REQUIRED', 'Your saved country has changed. Refresh and try again')
    }

    if (settingsResult.error || !settingsResult.data || !Number.isSafeInteger(Number(settingsResult.data.revision))) {
      throw settingsResult.error || new Error('Country rules unavailable')
    }

    if (exceptionResult.error) throw exceptionResult.error

    const settings = settingsResult.data
    if (String(claims.revision) !== String(settings.revision)) {
      return fail(res, 409, 'BOOK_COUNTRY_REFRESH_REQUIRED', 'Country settings changed. Refresh and try again')
    }

    if (settings.rules?.kh?.physicalBooks !== true || settings.rules?.kh?.payway !== true) {
      return fail(res, 403, 'BOOK_COUNTRY_BLOCKED', 'Physical book payment is not available')
    }

    const exception = exceptionResult.data
    const active = exception && (!exception.expires_at || Date.parse(exception.expires_at) > Date.now())
    if (
      active &&
      exception.mode === 'custom' &&
      (exception.overrides?.physicalBooks === 'block' || exception.overrides?.payway === 'block')
    ) {
      return fail(res, 403, 'BOOK_COUNTRY_BLOCKED', 'Physical book payment is disabled for your account')
    }

    return next()
  } catch (error) {
    console.error('PHYSICAL BOOK COUNTRY GATE ERROR:', String(error?.message || error))
    return fail(res, 503, 'BOOK_COUNTRY_UNAVAILABLE', 'Could not verify physical book availability')
  }
}
