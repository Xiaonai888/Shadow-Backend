import { supabase } from '../config/supabase.js'

const LANGUAGE_NAMES = Object.freeze({
  km: 'Khmer',
  en: 'English',
  zh: 'Chinese',
  ko: 'Korean',
  ja: 'Japanese',
})

const LANGUAGE_CODES = Object.keys(LANGUAGE_NAMES)
const CACHE_TTL_MS = 15_000
let cached = null
let cacheExpiresAt = 0
let pending = null
let revision = 0

function languageRows(rows) {
  const values = new Map((rows || []).map((row) => [row.language_code, row]))
  return LANGUAGE_CODES.map((code) => {
    const supported = code === 'km'
    const value = values.get(code)
    return {
      language: code,
      label: LANGUAGE_NAMES[code],
      enabled: supported && (value ? value.is_enabled === true : code === 'km'),
      supported,
      updated_at: value?.updated_at || null,
    }
  })
}

export async function getShadowReadEventLanguageControls({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() < cacheExpiresAt) return cached
  if (pending) return pending

  const requestedRevision = revision
  const work = (async () => {
    const { data, error } = await supabase
      .from('shadow_read_event_language_controls')
      .select('language_code,is_enabled,updated_at')
      .in('language_code', LANGUAGE_CODES)

    if (error) throw error
    const result = languageRows(data)
    if (revision === requestedRevision) {
      cached = result
      cacheExpiresAt = Date.now() + CACHE_TTL_MS
    }
    return result
  })()

  pending = work
  try {
    return await work
  } finally {
    if (pending === work) pending = null
  }
}

export async function getShadowReadEventLanguageEnabled(language) {
  if (!Object.hasOwn(LANGUAGE_NAMES, language)) return false
  if (language !== 'km') return false
  const rows = await getShadowReadEventLanguageControls()
  return rows.some((row) => row.language === language && row.enabled === true)
}

export async function updateShadowReadEventLanguageControl({ language, enabled, adminId }) {
  if (!Object.hasOwn(LANGUAGE_NAMES, language) || typeof enabled !== 'boolean') {
    const error = new Error('Invalid Read Event language control')
    error.code = 'READ_EVENT_LANGUAGE_INVALID'
    throw error
  }
  if (language !== 'km') {
    const error = new Error('International Read Events are not available yet')
    error.code = 'READ_EVENT_LANGUAGE_NOT_SUPPORTED'
    throw error
  }
  if (typeof adminId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(adminId)) {
    const error = new Error('Invalid administrator identity')
    error.code = 'READ_EVENT_ADMIN_INVALID'
    throw error
  }

  const { data, error } = await supabase
    .from('shadow_read_event_language_controls')
    .update({
      is_enabled: enabled,
      updated_at: new Date().toISOString(),
      updated_by: adminId,
    })
    .eq('language_code', language)
    .select('language_code,is_enabled,updated_at')
    .maybeSingle()

  if (error) throw error
  if (!data || data.is_enabled !== enabled) {
    const mismatch = new Error('Read Event language setting not found')
    mismatch.code = 'READ_EVENT_LANGUAGE_NOT_FOUND'
    throw mismatch
  }

  revision += 1
  cached = null
  cacheExpiresAt = 0
  return {
    language,
    label: LANGUAGE_NAMES[language],
    enabled: data.is_enabled,
    supported: true,
    updated_at: data.updated_at,
  }
}
