import { supabase } from '../config/supabase.js'
import { readReaderClassificationCountry } from '../services/readerClassificationCountrySource.service.js'

const METHOD_FLAGS = Object.freeze({
  bank_qr: 'payoutBank',
  binance: 'payoutBinance',
  phone: 'payoutPhone',
})

function allowedFromRule(rule, key, region) {
  if (typeof rule?.[key] === 'boolean') return rule[key]
  if (key === 'payoutBank') return region === 'kh'
  if (key === 'payoutPhone') return true
  return false
}

function activeException(item) {
  if (!item) return null
  if (item.expires_at && !(Date.parse(item.expires_at) > Date.now())) return null
  return item
}

function resolvePayoutAccess(rules, region, exception, key) {
  const baseline = exception?.mode === 'cambodia_experience' ? 'kh' : region
  let permitted = region === 'unknown'
    ? key === 'payoutBank' || key === 'payoutPhone'
    : allowedFromRule(rules?.[baseline], key, baseline)

  if (exception?.mode === 'custom') {
    if (exception.overrides?.[key] === 'allow') permitted = true
    if (exception.overrides?.[key] === 'block') permitted = false
  }
  return permitted
}

export function requireAuthorPayoutMethod(fixedMethodType = null) {
  return async function authorPayoutCountryGate(req, res, next) {
    const methodType = fixedMethodType || String(req.body?.method_type || req.body?.methodType || '').trim()
    const key = METHOD_FLAGS[methodType]
    if (!key) {
      return res.status(400).json({ ok: false, code: 'PAYOUT_METHOD_INVALID', message: 'Unsupported payout method' })
    }

    const userId = req.user?.user_id
    if (!userId) {
      return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: 'Login required' })
    }

    try {
      const [settingsResult, country, exceptionResult] = await Promise.all([
        supabase.from('shadow_country_settings').select('rules').eq('settings_key', 'default').single(),
        readReaderClassificationCountry(userId),
        supabase.from('shadow_country_user_exceptions')
          .select('mode,overrides,expires_at').eq('user_id', userId).maybeSingle(),
      ])

      if (settingsResult.error || exceptionResult.error ||
          !settingsResult.data?.rules?.kh || !settingsResult.data?.rules?.international) {
        throw settingsResult.error || exceptionResult.error || new Error('Country payout rules are unavailable')
      }

      const region = !country?.verified || !country.country
        ? 'unknown'
        : country.country === 'KH' ? 'kh' : 'international'
      const exception = activeException(exceptionResult.data)
      if (!resolvePayoutAccess(settingsResult.data.rules, region, exception, key)) {
        return res.status(403).json({
          ok: false,
          code: 'PAYOUT_METHOD_DISABLED',
          message: 'This payout method is not available for your account',
        })
      }
      return next()
    } catch (error) {
      console.error('AUTHOR PAYOUT COUNTRY GATE ERROR:', error?.message || error)
      return res.status(503).json({
        ok: false,
        code: 'PAYOUT_SETTINGS_UNAVAILABLE',
        message: 'Unable to verify payout availability. Please retry.',
      })
    }
  }
}
