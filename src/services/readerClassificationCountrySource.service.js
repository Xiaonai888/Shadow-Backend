import { supabase } from '../config/supabase.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const INVALID_COUNTRIES = new Set(['XX', 'ZZ', 'T1'])

function validCountry(value) {
  const code = String(value || '').trim().toUpperCase()
  return /^[A-Z]{2}$/.test(code) && !INVALID_COUNTRIES.has(code) ? code : null
}

export function isReaderClassificationCountryPolicyEnabled() {
  return false
}

export async function readReaderClassificationCountry(userId) {
  const id = String(userId || '').trim()
  if (!UUID.test(id)) {
    return {
      userId: id,
      country: null,
      verified: false,
      source: 'reader_classification_invalid_user',
    }
  }

  const { data, error } = await supabase
    .from('shadow_reader_classifications')
    .select('detected_country,admin_country_override')
    .eq('user_id', id)
    .maybeSingle()

  if (error) throw error

  const adminCountry = validCountry(data?.admin_country_override)
  const detectedCountry = validCountry(data?.detected_country)
  const country = adminCountry || detectedCountry

  return {
    userId: id,
    country,
    verified: Boolean(country),
    source: adminCountry
      ? 'reader_classification_admin_override'
      : detectedCountry
        ? 'reader_classification_saved_ip'
        : 'reader_classification_unknown',
  }
}
