import { createHash, randomBytes } from 'node:crypto'
import { supabase } from '../config/supabase.js'

const CHALLENGE_TABLE = 'rewarded_ad_challenges'
const AD_DAILY_LIMIT = 5
const CAMBODIA_TIME_OFFSET_MS = 7 * 60 * 60 * 1000
const CHALLENGE_TTL_MS = 10 * 60 * 1000
const CHALLENGE_RATE_WINDOW_MS = 60 * 1000
const CHALLENGE_RATE_LIMIT = 6
const BLOCKING_FREQUENCIES = new Set([
  'every_visit',
  'every_unlock',
])

function startOfTodayIso(date = new Date()) {
  const cambodiaDate = new Date(
    date.getTime() + CAMBODIA_TIME_OFFSET_MS
  )

  const localMidnightUtc = Date.UTC(
    cambodiaDate.getUTCFullYear(),
    cambodiaDate.getUTCMonth(),
    cambodiaDate.getUTCDate()
  )

  return new Date(
    localMidnightUtc - CAMBODIA_TIME_OFFSET_MS
  ).toISOString()
}

function hashChallengeToken(token) {
  return createHash('sha256')
    .update(token)
    .digest('hex')
}

async function countAdUnlocksToday(userId) {
  const { count, error } = await supabase
    .from('episode_unlock_transactions')
    .select('id', {
      count: 'exact',
      head: true,
    })
    .eq('user_id', userId)
    .eq('currency', 'ad')
    .eq('type', 'unlock')
    .gte('created_at', startOfTodayIso())

  if (error) throw error
  return Number(count || 0)
}

async function getEpisodeUnlockGoogleAdsState() {
  const [
    settingsResult,
    shadowAdResult,
  ] = await Promise.all([
    supabase
      .from('google_ads_settings')
      .select(
        'master_enabled,episode_unlock_enabled'
      )
      .eq('id', 1)
      .maybeSingle(),
    supabase
      .from('shadow_advertisements')
      .select('enabled,frequency')
      .eq('placement', 'freeUnlock')
      .maybeSingle(),
  ])

  if (settingsResult.error) {
    throw settingsResult.error
  }

  if (shadowAdResult.error) {
    throw shadowAdResult.error
  }

  const settings = settingsResult.data
  const shadowAd = shadowAdResult.data
  const shadowEnabled = Boolean(
    shadowAd?.enabled
  )
  const shadowFrequency = String(
    shadowAd?.frequency ||
      'once_per_session'
  ).trim()

  const suppressed =
    shadowEnabled &&
    BLOCKING_FREQUENCIES.has(
      shadowFrequency
    )

  const enabled =
    Boolean(settings?.master_enabled) &&
    Boolean(
      settings?.episode_unlock_enabled
    ) &&
    !suppressed

  return {
    enabled,
    suppressed,
    shadowEnabled,
    shadowFrequency,
  }
}

async function validateEpisode(
  storyId,
  episodeId
) {
  const { data, error } = await supabase
    .from('episodes')
    .select(
      'id,story_id,is_locked,status'
    )
    .eq('id', episodeId)
    .eq('story_id', storyId)
    .maybeSingle()

  if (error) throw error
  return data || null
}

async function enforceChallengeRateLimit(
  userId
) {
  const since = new Date(
    Date.now() -
      CHALLENGE_RATE_WINDOW_MS
  ).toISOString()

  const { count, error } = await supabase
    .from(CHALLENGE_TABLE)
    .select('id', {
      count: 'exact',
      head: true,
    })
    .eq('user_id', String(userId))
    .gte('created_at', since)

  if (error) throw error

  return Number(count || 0) <
    CHALLENGE_RATE_LIMIT
}

async function invalidateActiveChallenges(
  userId
) {
  const { error } = await supabase
    .from(CHALLENGE_TABLE)
    .update({
      consumed_at:
        new Date().toISOString(),
    })
    .eq('user_id', String(userId))
    .is('consumed_at', null)

  if (error) throw error
}

export async function createRewardedAdChallenge(
  req,
  res
) {
  try {
    const userId = req.user?.user_id
    const { storyId, episodeId } =
      req.params

    if (!userId) {
      return res.status(401).json({
        ok: false,
        code: 'LOGIN_REQUIRED',
        message: 'Login required',
      })
    }

    const googleAdsState =
      await getEpisodeUnlockGoogleAdsState()

    if (!googleAdsState.enabled) {
      return res.status(403).json({
        ok: false,
        code:
          googleAdsState.suppressed
            ? 'REWARDED_AD_SUPPRESSED'
            : 'REWARDED_AD_DISABLED',
        message:
          googleAdsState.suppressed
            ? 'Rewarded unlock is temporarily unavailable'
            : 'Rewarded unlock is disabled',
      })
    }

    const episode =
      await validateEpisode(
        storyId,
        episodeId
      )

    if (!episode) {
      return res.status(404).json({
        ok: false,
        code: 'EPISODE_NOT_FOUND',
        message: 'Episode not found',
      })
    }

    if (episode.is_locked === false) {
      return res.status(409).json({
        ok: false,
        code: 'EPISODE_NOT_LOCKED',
        message:
          'This episode does not need rewarded unlock',
      })
    }

    const usedToday =
      await countAdUnlocksToday(userId)

    if (usedToday >= AD_DAILY_LIMIT) {
      return res.status(403).json({
        ok: false,
        code:
          'AD_DAILY_LIMIT_REACHED',
        message:
          'Daily rewarded unlock limit reached',
        daily_limit: AD_DAILY_LIMIT,
        used_today: usedToday,
        remaining_today: 0,
      })
    }

    const allowed =
      await enforceChallengeRateLimit(
        userId
      )

    if (!allowed) {
      return res.status(429).json({
        ok: false,
        code:
          'REWARDED_AD_RATE_LIMITED',
        message:
          'Too many rewarded ad requests. Please try again shortly.',
      })
    }

    await invalidateActiveChallenges(
      userId
    )

    const token = randomBytes(32)
      .toString('base64url')
    const tokenHash =
      hashChallengeToken(token)
    const expiresAt = new Date(
      Date.now() + CHALLENGE_TTL_MS
    ).toISOString()

    const { error } = await supabase
      .from(CHALLENGE_TABLE)
      .insert({
        user_id: String(userId),
        story_id: String(storyId),
        episode_id:
          String(episodeId),
        token_hash: tokenHash,
        expires_at: expiresAt,
      })

    if (error?.code === '23505') {
      return res.status(409).json({
        ok: false,
        code:
          'REWARDED_AD_CHALLENGE_BUSY',
        message:
          'A rewarded ad request is already active',
      })
    }

    if (error) throw error

    return res.status(201).json({
      ok: true,
      challengeToken: token,
      expiresAt,
      dailyLimit: AD_DAILY_LIMIT,
      usedToday,
      remainingToday: Math.max(
        0,
        AD_DAILY_LIMIT - usedToday
      ),
    })
  } catch (error) {
    console.error(
      'CREATE REWARDED AD CHALLENGE ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to start rewarded unlock',
    })
  }
}

export async function consumeRewardedAdChallenge(
  req,
  res,
  next
) {
  try {
    const userId = req.user?.user_id
    const { storyId, episodeId } =
      req.params
    const token = String(
      req.body?.challengeToken || ''
    ).trim()

    if (!userId) {
      return res.status(401).json({
        ok: false,
        code: 'LOGIN_REQUIRED',
        message: 'Login required',
      })
    }

    if (!token) {
      return res.status(400).json({
        ok: false,
        code:
          'REWARDED_AD_CHALLENGE_REQUIRED',
        message:
          'Rewarded ad challenge is required',
      })
    }

    const googleAdsState =
      await getEpisodeUnlockGoogleAdsState()

    if (!googleAdsState.enabled) {
      return res.status(403).json({
        ok: false,
        code:
          googleAdsState.suppressed
            ? 'REWARDED_AD_SUPPRESSED'
            : 'REWARDED_AD_DISABLED',
        message:
          'Rewarded unlock is unavailable',
      })
    }

    const usedToday =
      await countAdUnlocksToday(userId)

    if (usedToday >= AD_DAILY_LIMIT) {
      return res.status(403).json({
        ok: false,
        code:
          'AD_DAILY_LIMIT_REACHED',
        message:
          'Daily rewarded unlock limit reached',
        daily_limit: AD_DAILY_LIMIT,
        used_today: usedToday,
        remaining_today: 0,
      })
    }

    const now =
      new Date().toISOString()
    const tokenHash =
      hashChallengeToken(token)

    const { data, error } = await supabase
      .from(CHALLENGE_TABLE)
      .update({
        consumed_at: now,
      })
      .eq(
        'token_hash',
        tokenHash
      )
      .eq(
        'user_id',
        String(userId)
      )
      .eq(
        'story_id',
        String(storyId)
      )
      .eq(
        'episode_id',
        String(episodeId)
      )
      .is('consumed_at', null)
      .gt('expires_at', now)
      .select('id')
      .maybeSingle()

    if (error) throw error

    if (!data?.id) {
      return res.status(403).json({
        ok: false,
        code:
          'REWARDED_AD_CHALLENGE_INVALID',
        message:
          'Rewarded ad challenge is invalid, expired, or already used',
      })
    }

    req.rewardedAdChallengeId =
      data.id

    return next()
  } catch (error) {
    console.error(
      'CONSUME REWARDED AD CHALLENGE ERROR:',
      error
    )

    return res.status(500).json({
      ok: false,
      message:
        'Failed to verify rewarded unlock',
    })
  }
}
