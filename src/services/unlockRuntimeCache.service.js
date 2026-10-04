import { supabase } from '../config/supabase.js'

const UNLOCK_RULES_CACHE_MS = 30 * 1000
const READ_GATE_UNLOCK_CACHE_MS = 15 * 1000
const READ_GATE_UNLOCK_NEGATIVE_CACHE_MS = 5 * 1000
const READ_GATE_UNLOCK_CACHE_LIMIT = 5000

let unlockRulesCache = null
let unlockRulesPending = null

const readGateUnlockCache = new Map()
const readGateUnlockPending = new Map()
const readGateUnlockGeneration = new Map()

function cacheKey({
  userId,
  storyId,
  episodeId,
}) {
  return [
    String(userId || ''),
    String(storyId || ''),
    String(episodeId || ''),
  ].join(':')
}

function generationFor(key) {
  return Number(
    readGateUnlockGeneration.get(key) || 0
  )
}

function bumpGeneration(key) {
  readGateUnlockGeneration.set(
    key,
    generationFor(key) + 1
  )
}

function trimReadGateCache() {
  while (
    readGateUnlockCache.size >=
    READ_GATE_UNLOCK_CACHE_LIMIT
  ) {
    readGateUnlockCache.delete(
      readGateUnlockCache
        .keys()
        .next()
        .value
    )
  }
}

function readCachedUnlock(key) {
  const cached =
    readGateUnlockCache.get(key)

  if (!cached) {
    return {
      hit: false,
      value: null,
    }
  }

  if (
    cached.expiresAt <=
    Date.now()
  ) {
    readGateUnlockCache.delete(
      key
    )

    return {
      hit: false,
      value: null,
    }
  }

  return {
    hit: true,
    value: cached.value,
  }
}

function writeCachedUnlock(
  key,
  value
) {
  const now = Date.now()
  let expiresAt =
    now +
    (
      value
        ? READ_GATE_UNLOCK_CACHE_MS
        : READ_GATE_UNLOCK_NEGATIVE_CACHE_MS
    )

  if (
    value?.expires_at
  ) {
    const unlockExpiresAt =
      new Date(
        value.expires_at
      ).getTime()

    if (
      Number.isFinite(
        unlockExpiresAt
      )
    ) {
      expiresAt =
        Math.min(
          expiresAt,
          unlockExpiresAt
        )
    }
  }

  if (
    expiresAt <= now
  ) {
    readGateUnlockCache.delete(
      key
    )
    return
  }

  trimReadGateCache()

  readGateUnlockCache.set(
    key,
    {
      value,
      expiresAt,
    }
  )
}

export async function getCachedPlatformUnlockRules(
  fallbackRules
) {
  const now = Date.now()

  if (
    unlockRulesCache &&
    unlockRulesCache.expiresAt > now
  ) {
    return unlockRulesCache.value
  }

  if (unlockRulesPending) {
    return unlockRulesPending
  }

  const request = (async () => {
    const { data, error } =
      await supabase
        .from(
          'platform_unlock_rules'
        )
        .select('*')
        .eq('id', 1)
        .maybeSingle()

    const value =
      error || !data
        ? fallbackRules
        : data

    unlockRulesCache = {
      value,
      expiresAt:
        Date.now() +
        UNLOCK_RULES_CACHE_MS,
    }

    return value
  })()

  unlockRulesPending = request

  try {
    return await request
  } finally {
    if (
      unlockRulesPending ===
      request
    ) {
      unlockRulesPending = null
    }
  }
}

export async function getCachedEpisodeReadGateUnlock({
  userId,
  storyId,
  episodeId,
}) {
  const key = cacheKey({
    userId,
    storyId,
    episodeId,
  })
  const cached =
    readCachedUnlock(key)

  if (cached.hit) {
    return cached.value
  }

  const generation =
    generationFor(key)
  const pending =
    readGateUnlockPending.get(key)

  if (
    pending &&
    pending.generation ===
      generation
  ) {
    return pending.promise
  }

  const request = (async () => {
    const { data, error } =
      await supabase
        .from('episode_unlocks')
        .select(
          'unlock_type, expires_at'
        )
        .eq(
          'user_id',
          userId
        )
        .eq(
          'story_id',
          storyId
        )
        .eq(
          'episode_id',
          episodeId
        )
        .eq(
          'unlock_status',
          'active'
        )
        .maybeSingle()

    if (error) throw error

    const unlock =
      data?.expires_at &&
      new Date(
        data.expires_at
      ).getTime() <= Date.now()
        ? null
        : data || null

    if (
      generationFor(key) ===
      generation
    ) {
      writeCachedUnlock(
        key,
        unlock
      )
    }

    return unlock
  })()

  readGateUnlockPending.set(
    key,
    {
      generation,
      promise: request,
    }
  )

  try {
    return await request
  } finally {
    const current =
      readGateUnlockPending.get(
        key
      )

    if (
      current?.promise ===
      request
    ) {
      readGateUnlockPending.delete(
        key
      )
    }
  }
}

export function invalidateEpisodeReadGateUnlockCache({
  userId,
  storyId,
  episodeIds = [],
}) {
  const ids = [
    ...new Set(
      (episodeIds || [])
        .map(
          (episodeId) =>
            String(
              episodeId || ''
            ).trim()
        )
        .filter(Boolean)
    ),
  ]

  for (const episodeId of ids) {
    const key = cacheKey({
      userId,
      storyId,
      episodeId,
    })

    bumpGeneration(key)
    readGateUnlockCache.delete(
      key
    )
    readGateUnlockPending.delete(
      key
    )
  }
}
