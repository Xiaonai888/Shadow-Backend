import jwt from 'jsonwebtoken'
import { supabase } from '../config/supabase.js'

const ISSUER = 'shadow-country-settings'
const AUDIENCE = 'shadow-payment-creation'

function fail(res, status, code, message) {
  return res.status(status).json({ ok: false, code, message })
}

export async function requireCambodiaPhysicalBooks(req, res, next) {
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
    const { data, error } = await supabase
      .from('shadow_country_settings')
      .select('rules,revision')
      .eq('settings_key', 'default')
      .single()

    if (error || !data || !Number.isSafeInteger(Number(data.revision))) {
      throw error || new Error('Country rules unavailable')
    }

    if (String(claims.revision) !== String(data.revision)) {
      return fail(res, 409, 'BOOK_COUNTRY_REFRESH_REQUIRED', 'Country settings changed. Refresh and try again')
    }

    if (data.rules?.kh?.physicalBooks !== true) {
      return fail(res, 403, 'BOOK_COUNTRY_BLOCKED', 'Physical book purchases are not available')
    }

    return next()
  } catch (error) {
    console.error('PHYSICAL BOOK COUNTRY GATE ERROR:', String(error?.message || error))
    return fail(res, 503, 'BOOK_COUNTRY_UNAVAILABLE', 'Could not verify physical book availability')
  }
}
