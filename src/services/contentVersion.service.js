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

const VERSION_CACHE_TTL_MS = 60 * 1000
const versionCache = new Map()
const versionCacheFetchedAt = new Map()
const keyLoadPromises = new Map()

function cleanKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 80)
}

function normalizeKeys(keys) {
  return [
    ...new Set(
      (
        Array.isArray(keys)
          ? keys
          : DEFAULT_KEYS
      )
        .map(cleanKey)
        .filter(Boolean)
    ),
  ]
}

function fallbackVersion(key) {
  return {
    key,
    version: 1,
    updated_at:
      new Date().toISOString(),
  }
}

function cacheRow(row) {
  const key = cleanKey(
    row?.content_key ||
    row?.key
  )

  if (!key) return null

  const value = {
    key,
    version: Number(
      row?.version || 1
    ),
    updated_at:
      row?.updated_at ||
      new Date().toISOString(),
  }

  versionCache.set(key, value)
  versionCacheFetchedAt.set(key, Date.now())
  return value
}

async function loadMissingKeys(keys) {
  const now = Date.now()
  const missing = keys.filter(
    (key) =>
      !keyLoadPromises.has(key) &&
      (!versionCache.has(key) ||
        now - Number(versionCacheFetchedAt.get(key) || 0) >= VERSION_CACHE_TTL_MS)
  )

  if (missing.length) {
    const loadPromise = (async () => {
      const { data, error } =
        await supabase
          .from('content_versions')
          .select(
            'content_key, version, updated_at'
          )
          .in(
            'content_key',
            missing
          )

      if (error) throw error

      const found = new Set()

      for (const row of data || []) {
        const cached = cacheRow(row)
        if (cached) {
          found.add(cached.key)
        }
      }

      for (const key of missing) {
        if (!found.has(key)) {
          versionCache.set(
            key,
            fallbackVersion(key)
          )
          versionCacheFetchedAt.set(key, Date.now())
        }
      }
    })()

    for (const key of missing) {
      keyLoadPromises.set(
        key,
        loadPromise
      )
    }

    const clearPending = () => {
      for (const key of missing) {
        if (
          keyLoadPromises.get(key) ===
          loadPromise
        ) {
          keyLoadPromises.delete(key)
        }
      }
    }
    void loadPromise.then(clearPending, clearPending)
  }

  const waits = [
    ...new Set(
      keys
        .map((key) =>
          keyLoadPromises.get(key)
        )
        .filter(Boolean)
    ),
  ]

  if (waits.length) {
    await Promise.all(waits)
  }
}

export async function getContentVersions(
  keys = DEFAULT_KEYS
) {
  const cleanKeys = normalizeKeys(keys)

  if (!cleanKeys.length) return {}

  try {
    await loadMissingKeys(cleanKeys)
  } catch (error) {
    console.warn(
      'GET CONTENT VERSIONS WARNING:',
      error.message
    )
  }

  return cleanKeys.reduce(
    (acc, key) => {
      acc[key] =
        versionCache.get(key) ||
        fallbackVersion(key)

      return acc
    },
    {}
  )
}

export async function bumpContentVersions(
  keys = []
) {
  const cleanKeys = normalizeKeys(
    Array.isArray(keys)
      ? keys
      : [keys]
  )

  if (!cleanKeys.length) return {}

  try {
    const current =
      await getContentVersions(
        cleanKeys
      )
    const now =
      new Date().toISOString()

    const payload = cleanKeys.map(
      (key) => ({
        content_key: key,
        version:
          Number(
            current[key]?.version || 1
          ) + 1,
        updated_at: now,
      }))

    const { data, error } =
      await supabase
        .from('content_versions')
        .upsert(
          payload,
          {
            onConflict:
              'content_key',
          }
        )
        .select(
          'content_key, version, updated_at'
        )

    if (error) throw error

    const result = {}

    for (const row of data || []) {
      const cached = cacheRow(row)

      if (cached) {
        result[cached.key] = cached
      }
    }

    for (const item of payload) {
      const key = item.content_key

      if (!result[key]) {
        const cached =
          cacheRow(item)
        result[key] = cached
      }
    }

    return result
  } catch (error) {
    console.warn(
      'BUMP CONTENT VERSIONS WARNING:',
      error.message
    )

    return cleanKeys.reduce(
      (acc, key) => {
        acc[key] =
          versionCache.get(key) ||
          fallbackVersion(key)
        return acc
      },
      {}
    )
  }
}
