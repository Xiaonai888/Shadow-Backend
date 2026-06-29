import { supabase } from '../config/supabase.js'

const DEFAULT_KEYS = [
  'home',
  'slides',
  'stories',
  'genres',
  'ranking',
  'tasks',
  'notifications',
  'comments',
  'library',
]

function cleanKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 80)
}

function fallbackVersions(keys = DEFAULT_KEYS) {
  const now = new Date().toISOString()

  return keys.reduce((acc, key) => {
    const clean = cleanKey(key)

    if (clean) {
      acc[clean] = {
        key: clean,
        version: 1,
        updated_at: now,
      }
    }

    return acc
  }, {})
}

export async function getContentVersions(keys = DEFAULT_KEYS) {
  const cleanKeys = [...new Set((Array.isArray(keys) ? keys : DEFAULT_KEYS).map(cleanKey).filter(Boolean))]
  const now = new Date().toISOString()

  if (!cleanKeys.length) return {}

  try {
    const { data, error } = await supabase
      .from('content_versions')
      .select('content_key, version, updated_at')
      .in('content_key', cleanKeys)

    if (error) throw error

    const map = fallbackVersions(cleanKeys)

    for (const row of data || []) {
      map[row.content_key] = {
        key: row.content_key,
        version: Number(row.version || 1),
        updated_at: row.updated_at || now,
      }
    }

    return map
  } catch (error) {
    console.warn('GET CONTENT VERSIONS WARNING:', error.message)
    return fallbackVersions(cleanKeys)
  }
}

export async function bumpContentVersions(keys = []) {
  const cleanKeys = [...new Set((Array.isArray(keys) ? keys : [keys]).map(cleanKey).filter(Boolean))]
  const now = new Date().toISOString()

  if (!cleanKeys.length) return {}

  try {
    const current = await getContentVersions(cleanKeys)
    const payload = cleanKeys.map((key) => ({
      content_key: key,
      version: Number(current[key]?.version || 1) + 1,
      updated_at: now,
    }))

    const { data, error } = await supabase
      .from('content_versions')
      .upsert(payload, { onConflict: 'content_key' })
      .select('content_key, version, updated_at')

    if (error) throw error

    return (data || []).reduce((acc, row) => {
      acc[row.content_key] = {
        key: row.content_key,
        version: Number(row.version || 1),
        updated_at: row.updated_at || now,
      }

      return acc
    }, {})
  } catch (error) {
    console.warn('BUMP CONTENT VERSIONS WARNING:', error.message)
    return fallbackVersions(cleanKeys)
  }
}
