import { supabase } from '../config/supabase.js'

const TARGET_EPISODES = 100
const READ_THRESHOLD_PERCENT = 80
const MILESTONES = Array.from({ length: 10 }, (_, index) => (index + 1) * 10)
const weeklyReadingLocks = new Map()

function getUserId(req) {
  return req.user?.user_id || req.user?.id || null
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '').trim()
  )
}

function isPremiumRole(role) {
  const value = String(role || '').trim().toLowerCase()
  return value === 'premium' || value === 'vip'
}

function getPhnomPenhDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Phnom_Penh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)

  const year = parts.find((part) => part.type === 'year')?.value
  const month = parts.find((part) => part.type === 'month')?.value
  const day = parts.find((part) => part.type === 'day')?.value

  return `${year}-${month}-${day}`
}

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function getWeekStartKey(date = new Date()) {
  const dateKey = getPhnomPenhDateKey(date)
  const localDate = new Date(`${dateKey}T00:00:00.000Z`)
  const day = localDate.getUTCDay()
  const daysFromMonday = (day + 6) % 7
  return addDays(dateKey, -daysFromMonday)
}

async function withWeeklyReadingLock(userId, callback) {
  const previous = weeklyReadingLocks.get(userId) || Promise.resolve()
  let releaseCurrent

  const current = new Promise((resolve) => {
    releaseCurrent = resolve
  })

  const queued = previous.catch(() => {}).then(() => current)
  weeklyReadingLocks.set(userId, queued)
  await previous.catch(() => {})

  try {
    return await callback()
  } finally {
    releaseCurrent()
    if (weeklyReadingLocks.get(userId) === queued) {
      weeklyReadingLocks.delete(userId)
    }
  }
}

async function getUserProfile(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('id, role')
    .eq('id', userId)
    .maybeSingle()

  if (error) throw error
  return data || null
}

async function getOrCreateWallet(userId) {
  const { data: existingWallet, error: existingError } = await supabase
    .from('user_wallets')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()

  if (existingError) throw existingError
  if (existingWallet) return existingWallet

  const { data, error } = await supabase
    .from('user_wallets')
    .insert({
      user_id: userId,
      diamond_balance: 0,
      gem_balance: 0,
      voucher_balance: 0,
    })
    .select('*')
    .single()

  if (error) throw error
  return data
}

async function getEpisodeCount(userId, weekStart) {
  const { count, error } = await supabase
    .from('reader_weekly_reading_episodes')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('week_start', weekStart)

  if (error) throw error
  return Math.min(TARGET_EPISODES, Math.max(0, Number(count || 0)))
}

async function getClaims(userId, weekStart) {
  const { data, error } = await supabase
    .from('reader_weekly_reading_claims')
    .select('milestone, vouchers, auto_claimed, claimed_at')
    .eq('user_id', userId)
    .eq('week_start', weekStart)
    .order('milestone', { ascending: true })

  if (error) throw error
  return Array.isArray(data) ? data : []
}

async function addRewardHistory(userId, weekStart, milestone, autoClaimed) {
  const { error } = await supabase.from('reader_reward_history').insert({
    user_id: userId,
    source_key: 'weekly_reading',
    source_title: 'Weekly Reading',
    amount_gems: 0,
    amount_vouchers: 1,
    story_cards: 0,
    metadata: {
      week_start: weekStart,
      milestone,
      auto_claimed: Boolean(autoClaimed),
    },
  })

  if (error) {
    console.error('WEEKLY_READING_HISTORY_ERROR', error)
  }
}

async function grantMilestone(userId, weekStart, milestone, autoClaimed) {
  const episodeCount = await getEpisodeCount(userId, weekStart)

  if (episodeCount < milestone) {
    return { granted: false, reason: 'not_completed' }
  }

  const now = new Date().toISOString()

  const { data: insertedClaim, error: claimError } = await supabase
    .from('reader_weekly_reading_claims')
    .insert({
      user_id: userId,
      week_start: weekStart,
      milestone,
      vouchers: 1,
      auto_claimed: Boolean(autoClaimed),
      claimed_at: now,
    })
    .select('id, milestone')
    .single()

  if (claimError) {
    if (claimError.code === '23505') {
      return { granted: false, reason: 'already_claimed' }
    }
    throw claimError
  }

  try {
    const wallet = await getOrCreateWallet(userId)
    const nextVoucherBalance = Number(wallet.voucher_balance || 0) + 1

    const { data: updatedWallet, error: walletError } = await supabase
      .from('user_wallets')
      .update({
        voucher_balance: nextVoucherBalance,
        updated_at: now,
      })
      .eq('user_id', userId)
      .select('*')
      .single()

    if (walletError) throw walletError

    await addRewardHistory(userId, weekStart, milestone, autoClaimed)

    return {
      granted: true,
      milestone,
      wallet: updatedWallet,
    }
  } catch (error) {
    await supabase
      .from('reader_weekly_reading_claims')
      .delete()
      .eq('id', insertedClaim.id)

    throw error
  }
}

async function autoClaimEligibleMilestones(userId, weekStart, episodeCount) {
  const claims = await getClaims(userId, weekStart)
  const claimedSet = new Set(claims.map((item) => Number(item.milestone)))

  for (const milestone of MILESTONES) {
    if (milestone > episodeCount) break
    if (claimedSet.has(milestone)) continue

    const result = await grantMilestone(userId, weekStart, milestone, true)
    if (result.granted) {
      claimedSet.add(milestone)
    }
  }
}

async function buildWeeklyReadingState(userId, isPremium) {
  const weekStart = getWeekStartKey()
  let episodeCount = await getEpisodeCount(userId, weekStart)

  if (isPremium && episodeCount > 0) {
    await autoClaimEligibleMilestones(userId, weekStart, episodeCount)
  }

  episodeCount = await getEpisodeCount(userId, weekStart)
  const claims = await getClaims(userId, weekStart)
  const claimMap = new Map(claims.map((item) => [Number(item.milestone), item]))

  const milestones = MILESTONES.map((milestone) => {
    const claim = claimMap.get(milestone)
    const completed = episodeCount >= milestone
    const claimed = Boolean(claim)

    return {
      episodes: milestone,
      vouchers: 1,
      completed,
      claimed,
      auto_claimed: Boolean(claim?.auto_claimed),
      claimed_at: claim?.claimed_at || null,
      claimable: completed && !claimed && !isPremium,
    }
  })

  const nextMilestone =
    milestones.find((item) => !item.claimed)?.episodes || TARGET_EPISODES

  return {
    title: 'Weekly Reading',
    week_start: weekStart,
    week_end: addDays(weekStart, 6),
    episodes_read: episodeCount,
    target_episodes: TARGET_EPISODES,
    progress_percent: Math.min(
      100,
      Math.round((episodeCount / TARGET_EPISODES) * 100)
    ),
    premium_auto_claim: Boolean(isPremium),
    next_milestone: nextMilestone,
    milestones,
    completed: episodeCount >= TARGET_EPISODES,
    all_rewards_claimed: milestones.every((item) => item.claimed),
  }
}

export async function getWeeklyReading(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'User is required' })
    }

    const profile = await getUserProfile(userId)
    const isPremium = isPremiumRole(profile?.role)

    const weeklyReading = await withWeeklyReadingLock(userId, () =>
      buildWeeklyReadingState(userId, isPremium)
    )

    return res.json({
      ok: true,
      weekly_reading: weeklyReading,
    })
  } catch (error) {
    console.error('GET_WEEKLY_READING_ERROR', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to load Weekly Reading',
      error: error.message,
    })
  }
}

export async function trackWeeklyReadingProgress(req, res) {
  try {
    const userId = getUserId(req)
    const storyId = String(req.body.story_id || '').trim()
    const episodeId = String(req.body.episode_id || '').trim()
    const readingPercent = Math.min(
      100,
      Math.max(0, Number(req.body.reading_percent || 0))
    )

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'User is required' })
    }

    if (!isUuid(storyId) || !isUuid(episodeId)) {
      return res.status(400).json({
        ok: false,
        message: 'Valid story_id and episode_id are required',
      })
    }

    const profile = await getUserProfile(userId)
    const isPremium = isPremiumRole(profile?.role)

    const result = await withWeeklyReadingLock(userId, async () => {
      const weekStart = getWeekStartKey()
      const currentCount = await getEpisodeCount(userId, weekStart)

      if (currentCount >= TARGET_EPISODES) {
        return {
          counted: false,
          reason: 'weekly_target_completed',
          weeklyReading: await buildWeeklyReadingState(userId, isPremium),
        }
      }

      if (readingPercent < READ_THRESHOLD_PERCENT) {
        return {
          counted: false,
          reason: 'reading_not_completed',
          weeklyReading: await buildWeeklyReadingState(userId, isPremium),
        }
      }

      const [
        { data: story, error: storyError },
        { data: episode, error: episodeError },
      ] = await Promise.all([
        supabase
          .from('stories')
          .select('id')
          .eq('id', storyId)
          .eq('status', 'published')
          .is('deleted_at', null)
          .maybeSingle(),
        supabase
          .from('episodes')
          .select('id, story_id')
          .eq('id', episodeId)
          .eq('story_id', storyId)
          .eq('status', 'published')
          .is('deleted_at', null)
          .maybeSingle(),
      ])

      if (storyError) throw storyError
      if (episodeError) throw episodeError

      if (!story || !episode) {
        return {
          notFound: true,
        }
      }

      const { error: insertError } = await supabase
        .from('reader_weekly_reading_episodes')
        .insert({
          user_id: userId,
          week_start: weekStart,
          story_id: storyId,
          episode_id: episodeId,
        })

      let counted = true

      if (insertError) {
        if (insertError.code === '23505') {
          counted = false
        } else {
          throw insertError
        }
      }

      const weeklyReading = await buildWeeklyReadingState(userId, isPremium)

      return {
        counted,
        reason: counted ? 'counted' : 'episode_already_counted',
        weeklyReading,
      }
    })

    if (result.notFound) {
      return res.status(404).json({
        ok: false,
        message: 'Story or episode was not found',
      })
    }

    return res.json({
      ok: true,
      counted: result.counted,
      reason: result.reason,
      weekly_reading: result.weeklyReading,
    })
  } catch (error) {
    console.error('TRACK_WEEKLY_READING_ERROR', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to update Weekly Reading',
      error: error.message,
    })
  }
}

export async function claimWeeklyReadingReward(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'User is required' })
    }

    const profile = await getUserProfile(userId)
    const isPremium = isPremiumRole(profile?.role)

    const result = await withWeeklyReadingLock(userId, async () => {
      const weekStart = getWeekStartKey()
      const episodeCount = await getEpisodeCount(userId, weekStart)

      if (isPremium) {
        await autoClaimEligibleMilestones(userId, weekStart, episodeCount)

        return {
          autoClaimed: true,
          weeklyReading: await buildWeeklyReadingState(userId, true),
        }
      }

      const claims = await getClaims(userId, weekStart)
      const claimedSet = new Set(claims.map((item) => Number(item.milestone)))

      const milestone = MILESTONES.find(
        (item) => item <= episodeCount && !claimedSet.has(item)
      )

      if (!milestone) {
        return {
          noReward: true,
          weeklyReading: await buildWeeklyReadingState(userId, false),
        }
      }

      const grant = await grantMilestone(userId, weekStart, milestone, false)

      return {
        grant,
        weeklyReading: await buildWeeklyReadingState(userId, false),
      }
    })

    if (result.noReward) {
      return res.status(400).json({
        ok: false,
        message: 'No Weekly Reading reward is ready to claim',
        weekly_reading: result.weeklyReading,
      })
    }

    return res.json({
      ok: true,
      auto_claimed: Boolean(result.autoClaimed),
      claimed_milestone: result.grant?.milestone || null,
      weekly_reading: result.weeklyReading,
    })
  } catch (error) {
    console.error('CLAIM_WEEKLY_READING_ERROR', error)
    return res.status(500).json({
      ok: false,
      message: 'Failed to claim Weekly Reading reward',
      error: error.message,
    })
  }
}
