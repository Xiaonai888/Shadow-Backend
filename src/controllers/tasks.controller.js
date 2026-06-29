import { supabase } from '../config/supabase.js'

const DAILY_REWARDS = [
  { day: 1, gems: 50, coins: 50, vouchers: 0, story_cards: 0, gift: false },
  { day: 2, gems: 100, coins: 100, vouchers: 0, story_cards: 0, gift: false },
  { day: 3, gems: 150, coins: 150, vouchers: 0, story_cards: 0, gift: false },
  { day: 4, gems: 200, coins: 200, vouchers: 0, story_cards: 0, gift: false },
  { day: 5, gems: 250, coins: 250, vouchers: 0, story_cards: 0, gift: false },
  { day: 6, gems: 300, coins: 300, vouchers: 0, story_cards: 0, gift: false },
  { day: 7, gems: 0, coins: 0, vouchers: 1, story_cards: 0, gift: true },
]

const CHEST_COOLDOWN_MS = 4 * 60 * 60 * 1000
const CHEST_MAX_STORAGE = 2

const READING_REWARD_MILESTONES = [
  { seconds: 60, minutes: 1, coins: 5 },
  { seconds: 300, minutes: 5, coins: 5 },
  { seconds: 600, minutes: 10, coins: 10 },
  { seconds: 1200, minutes: 20, coins: 15 },
  { seconds: 1800, minutes: 30, coins: 15 },
]

const MAX_READING_REWARD_SECONDS = 1800
const MAX_READING_EVENT_SECONDS = 60

function getUserId(req) {
  return req.user?.user_id || req.user?.id || null
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

function isPremiumRole(role) {
  const value = String(role || '').trim().toLowerCase()

  return value === 'premium' || value === 'vip'
}

function getRandomGiftCoins() {
  const chance = Math.random()

  if (chance < 0.55) return 500
  if (chance < 0.8) return 600
  if (chance < 0.95) return 800

  return 1000
}

function getRandomChestCoins() {
  const chance = Math.random()

  if (chance < 0.55) return 30
  if (chance < 0.85) return 50
  if (chance < 0.97) return 80

  return 100
}

function publicWallet(wallet) {
  const coinBalance = Number(wallet?.gem_balance || 0)

  return {
    diamond_balance: Number(wallet?.diamond_balance || 0),
    gem_balance: coinBalance,
    coin_balance: coinBalance,
    voucher_balance: Number(wallet?.voucher_balance || 0),
  }
}

function publicCheckIn(row, isPremium = false) {
  const todayKey = getPhnomPenhDateKey()
  const yesterdayKey = addDays(todayKey, -1)
  const lastClaimDate = row?.last_claim_date || ''
  const lastCurrentDay = Number(row?.current_day || 0)
  const claimedToday = lastClaimDate === todayKey
  const activeStreak = lastClaimDate === todayKey || lastClaimDate === yesterdayKey
  const nextDay = activeStreak ? (lastCurrentDay % 7) + 1 : 1
  const currentDay = claimedToday ? lastCurrentDay || 1 : nextDay || 1

  return {
    streak_count: activeStreak ? Number(row?.streak_count || 0) : 0,
    current_day: currentDay,
    claimed_today: claimedToday,
    last_claim_date: lastClaimDate || null,
    next_claim_date: claimedToday ? addDays(todayKey, 1) : todayKey,
    premium_auto_claim: Boolean(isPremium),
    rewards: DAILY_REWARDS,
  }
}

function publicHistoryItem(item) {
  return {
    id: item.id,
    source_key: item.source_key,
    source_title: item.source_title,
    amount_gems: Number(item.amount_gems || 0),
    amount_coins: Number(item.amount_gems || 0),
    amount_diamonds: Number(item.amount_diamonds || 0),
    amount_vouchers: Number(item.amount_vouchers || 0),
    story_cards: Number(item.story_cards || 0),
    created_at: item.created_at,
  }
}

function publicRewardChest(row) {
  const now = new Date()
  const storedChests = Math.min(CHEST_MAX_STORAGE, Math.max(0, Number(row?.stored_chests || 0)))
  const lastRefillAt = row?.last_refill_at ? new Date(row.last_refill_at) : now

  if (storedChests >= CHEST_MAX_STORAGE) {
    return {
      available_chests: CHEST_MAX_STORAGE,
      max_chests: CHEST_MAX_STORAGE,
      is_full: true,
      next_chest_at: null,
      ms_until_next: 0,
      effective_last_refill_at: now.toISOString(),
    }
  }

  function cleanUuid(value) {
  const text = String(value || '').trim()

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)
    ? text
    : null
}

function publicReadingReward(row) {
  const todayKey = getPhnomPenhDateKey()
  const activeSeconds = Math.min(MAX_READING_REWARD_SECONDS, Math.max(0, Number(row?.active_seconds || 0)))
  const claimedMilestones = Array.isArray(row?.claimed_milestones)
    ? row.claimed_milestones.map(Number)
    : []

  const milestones = READING_REWARD_MILESTONES.map((item) => {
    const claimed = claimedMilestones.includes(item.seconds)
    const completed = activeSeconds >= item.seconds

    return {
      ...item,
      completed,
      claimed,
      claimable: completed && !claimed,
    }
  })

  return {
    reward_date: row?.reward_date || todayKey,
    active_seconds: activeSeconds,
    active_minutes: Math.floor(activeSeconds / 60),
    target_seconds: MAX_READING_REWARD_SECONDS,
    target_minutes: 30,
    claimed_milestones: claimedMilestones,
    milestones,
    claimable_coins: milestones.filter((item) => item.claimable).reduce((sum, item) => sum + item.coins, 0),
    total_earned_coins: milestones.filter((item) => item.claimed).reduce((sum, item) => sum + item.coins, 0),
    done_today: activeSeconds >= MAX_READING_REWARD_SECONDS && milestones.every((item) => item.claimed),
  }
}

  const elapsedMs = Math.max(0, now.getTime() - lastRefillAt.getTime())
  const gained = Math.floor(elapsedMs / CHEST_COOLDOWN_MS)
  const availableChests = Math.min(CHEST_MAX_STORAGE, storedChests + gained)

  let effectiveLastRefillMs = lastRefillAt.getTime()

  if (gained > 0) {
    effectiveLastRefillMs =
      availableChests >= CHEST_MAX_STORAGE
        ? now.getTime()
        : lastRefillAt.getTime() + gained * CHEST_COOLDOWN_MS
  }

  const isFull = availableChests >= CHEST_MAX_STORAGE
  const nextChestAt = isFull ? null : new Date(effectiveLastRefillMs + CHEST_COOLDOWN_MS)
  const msUntilNext = nextChestAt ? Math.max(0, nextChestAt.getTime() - now.getTime()) : 0

  return {
    available_chests: availableChests,
    max_chests: CHEST_MAX_STORAGE,
    is_full: isFull,
    next_chest_at: nextChestAt ? nextChestAt.toISOString() : null,
    ms_until_next: msUntilNext,
    effective_last_refill_at: new Date(effectiveLastRefillMs).toISOString(),
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

async function getCheckInRow(userId) {
  const { data, error } = await supabase
    .from('reader_checkins')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error

  return data || null
}

async function getOrCreateRewardChest(userId) {
  const { data: existingChest, error: existingError } = await supabase
    .from('reader_reward_chests')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()

  if (existingError) throw existingError
  if (existingChest) return existingChest

  const now = new Date().toISOString()

  const { data, error } = await supabase
    .from('reader_reward_chests')
    .insert({
      user_id: userId,
      stored_chests: 0,
      last_refill_at: now,
      updated_at: now,
    })
    .select('*')
    .single()

  if (error) throw error

  return data
}


async function getOrCreateReadingReward(userId) {
  const todayKey = getPhnomPenhDateKey()

  const { data: existingReward, error: existingError } = await supabase
    .from('reader_reading_rewards')
    .select('*')
    .eq('user_id', userId)
    .eq('reward_date', todayKey)
    .maybeSingle()

  if (existingError) throw existingError
  if (existingReward) return existingReward

  const now = new Date().toISOString()

  const { data, error } = await supabase
    .from('reader_reading_rewards')
    .insert({
      user_id: userId,
      reward_date: todayKey,
      active_seconds: 0,
      claimed_milestones: [],
      updated_at: now,
    })
    .select('*')
    .single()

  if (error) throw error

  return data
}

async function claimCheckInReward(userId, sourceKey = 'daily_bonus') {
  const todayKey = getPhnomPenhDateKey()
  const yesterdayKey = addDays(todayKey, -1)
  const [wallet, existingCheckIn] = await Promise.all([
    getOrCreateWallet(userId),
    getCheckInRow(userId),
  ])

  if (existingCheckIn?.last_claim_date === todayKey) {
    return {
      already_claimed: true,
      wallet,
      check_in: existingCheckIn,
      reward: null,
      history_item: null,
    }
  }

  const continueStreak = existingCheckIn?.last_claim_date === yesterdayKey
  const nextStreak = continueStreak ? Number(existingCheckIn?.streak_count || 0) + 1 : 1
  const currentDay = ((nextStreak - 1) % 7) + 1
  const reward = DAILY_REWARDS.find((item) => item.day === currentDay) || DAILY_REWARDS[0]
  const now = new Date().toISOString()
  const isGiftReward = Boolean(reward.gift || Number(reward.vouchers || 0) > 0)
  const rewardCoins = isGiftReward ? getRandomGiftCoins() : Number(reward.coins || reward.gems || 0)
  const rewardVouchers = isGiftReward ? 1 : Number(reward.vouchers || 0)

  const { data: savedCheckIn, error: checkInError } = await supabase
    .from('reader_checkins')
    .upsert(
      {
        user_id: userId,
        streak_count: nextStreak,
        current_day: currentDay,
        last_claim_date: todayKey,
        total_claims: Number(existingCheckIn?.total_claims || 0) + 1,
        updated_at: now,
      },
      {
        onConflict: 'user_id',
      }
    )
    .select('*')
    .single()

  if (checkInError) throw checkInError

  const nextGemBalance = Number(wallet.gem_balance || 0) + rewardCoins
  const nextVoucherBalance = Number(wallet.voucher_balance || 0) + rewardVouchers

  const { data: updatedWallet, error: walletError } = await supabase
    .from('user_wallets')
    .update({
      gem_balance: nextGemBalance,
      voucher_balance: nextVoucherBalance,
      updated_at: now,
    })
    .eq('user_id', userId)
    .select('*')
    .single()

  if (walletError) throw walletError

  const claimedReward = {
    ...reward,
    gems: rewardCoins,
    coins: rewardCoins,
    vouchers: rewardVouchers,
    story_cards: 0,
    gift: isGiftReward,
  }

  const { data: historyItem, error: historyError } = await supabase
    .from('reader_reward_history')
    .insert({
      user_id: userId,
      source_key: sourceKey,
      source_title: isGiftReward
        ? 'Daily Gift'
        : sourceKey === 'premium_auto_claim'
          ? 'Premium Auto Claim'
          : 'Daily Check-in',
      amount_gems: rewardCoins,
      amount_vouchers: rewardVouchers,
      story_cards: 0,
      metadata: {
        day: currentDay,
        streak_count: nextStreak,
        gift: isGiftReward,
        coins: rewardCoins,
        vouchers: rewardVouchers,
      },
    })
    .select('*')
    .single()

  if (historyError) throw historyError

  return {
    already_claimed: false,
    wallet: updatedWallet,
    check_in: savedCheckIn,
    reward: claimedReward,
    history_item: historyItem,
  }
}

export async function getTaskCheckIn(req, res) {
  try {
    const userId = getUserId(req)
    const user = await getUserProfile(userId)
    const isPremium = isPremiumRole(user?.role)
    let wallet = await getOrCreateWallet(userId)
    let checkInRow = await getCheckInRow(userId)

    if (isPremium && !publicCheckIn(checkInRow, isPremium).claimed_today) {
      const claimed = await claimCheckInReward(userId, 'premium_auto_claim')
      wallet = claimed.wallet
      checkInRow = claimed.check_in
    }

    return res.status(200).json({
      ok: true,
      wallet: publicWallet(wallet),
      check_in: publicCheckIn(checkInRow, isPremium),
    })
  } catch (error) {
    console.error('GET TASK CHECK IN ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load check-in',
      error: error.message,
    })
  }
}

export async function claimTaskCheckIn(req, res) {
  try {
    const userId = getUserId(req)
    const user = await getUserProfile(userId)
    const isPremium = isPremiumRole(user?.role)
    const result = await claimCheckInReward(userId, 'daily_bonus')

    return res.status(200).json({
      ok: true,
      already_claimed: result.already_claimed,
      wallet: publicWallet(result.wallet),
      check_in: publicCheckIn(result.check_in, isPremium),
      reward: result.reward,
      history_item: result.history_item ? publicHistoryItem(result.history_item) : null,
      message: result.already_claimed
        ? 'Already claimed today'
        : result.reward?.gift
          ? 'Daily gift claimed'
          : 'Daily check-in claimed',
    })
  } catch (error) {
    console.error('CLAIM TASK CHECK IN ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to claim check-in',
      error: error.message,
    })
  }
}

export async function getRewardChest(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'User is required' })
    }

    const chest = await getOrCreateRewardChest(userId)

    return res.status(200).json({
      ok: true,
      chest: publicRewardChest(chest),
    })
  } catch (error) {
    console.error('GET REWARD CHEST ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load reward chest',
      error: error.message,
    })
  }
}

export async function claimRewardChest(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'User is required' })
    }

    const chest = await getOrCreateRewardChest(userId)
    const chestStatus = publicRewardChest(chest)

    if (Number(chestStatus.available_chests || 0) < 1) {
      return res.status(400).json({
        ok: false,
        message: 'Chest is not ready yet',
        chest: chestStatus,
      })
    }

    const now = new Date().toISOString()
    const rewardCoins = getRandomChestCoins()
    const remainingChests = Math.max(0, Number(chestStatus.available_chests || 0) - 1)
    const nextLastRefillAt = chestStatus.is_full ? now : chestStatus.effective_last_refill_at || now

    const wallet = await getOrCreateWallet(userId)
    const nextCoinBalance = Number(wallet.gem_balance || 0) + rewardCoins

    const { data: updatedWallet, error: walletError } = await supabase
      .from('user_wallets')
      .update({
        gem_balance: nextCoinBalance,
        updated_at: now,
      })
      .eq('user_id', userId)
      .select('*')
      .single()

    if (walletError) throw walletError

    const { data: updatedChest, error: chestError } = await supabase
      .from('reader_reward_chests')
      .update({
        stored_chests: remainingChests,
        last_refill_at: nextLastRefillAt,
        updated_at: now,
      })
      .eq('user_id', userId)
      .select('*')
      .single()

    if (chestError) throw chestError

    const { data: historyItem, error: historyError } = await supabase
      .from('reader_reward_history')
      .insert({
        user_id: userId,
        source_key: 'reward_chest',
        source_title: 'Reward Chest',
        amount_gems: rewardCoins,
        amount_vouchers: 0,
        story_cards: 0,
        metadata: {
          coins: rewardCoins,
          chest_cooldown_hours: 4,
          remaining_chests: remainingChests,
        },
      })
      .select('*')
      .single()

    if (historyError) throw historyError

    return res.status(200).json({
      ok: true,
      wallet: publicWallet(updatedWallet),
      chest: publicRewardChest(updatedChest),
      reward: {
        coins: rewardCoins,
        gems: rewardCoins,
      },
      history_item: historyItem ? publicHistoryItem(historyItem) : null,
      message: 'Reward chest claimed',
    })
  } catch (error) {
    console.error('CLAIM REWARD CHEST ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to claim reward chest',
      error: error.message,
    })
  }
}

export async function getReadingReward(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'User is required' })
    }

    const reward = await getOrCreateReadingReward(userId)

    return res.status(200).json({
      ok: true,
      reading_reward: publicReadingReward(reward),
    })
  } catch (error) {
    console.error('GET READING REWARD ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load reading reward',
      error: error.message,
    })
  }
}

export async function trackReadingRewardProgress(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'User is required' })
    }

    const reward = await getOrCreateReadingReward(userId)
    const currentSeconds = Math.min(MAX_READING_REWARD_SECONDS, Math.max(0, Number(reward.active_seconds || 0)))
    const requestedSeconds = Math.floor(Number(req.body?.seconds || req.body?.seconds_added || 0))
    const secondsToAdd = Math.min(MAX_READING_EVENT_SECONDS, Math.max(0, requestedSeconds))
    const nextSeconds = Math.min(MAX_READING_REWARD_SECONDS, currentSeconds + secondsToAdd)
    const actualSecondsAdded = Math.max(0, nextSeconds - currentSeconds)
    const now = new Date().toISOString()

    let updatedReward = reward

    if (actualSecondsAdded > 0) {
      const { data, error } = await supabase
        .from('reader_reading_rewards')
        .update({
          active_seconds: nextSeconds,
          updated_at: now,
        })
        .eq('id', reward.id)
        .select('*')
        .single()

      if (error) throw error
      updatedReward = data

      await supabase
        .from('reader_reading_reward_events')
        .insert({
          user_id: userId,
          reward_date: reward.reward_date,
          story_id: cleanUuid(req.body?.story_id),
          episode_id: cleanUuid(req.body?.episode_id),
          seconds_added: actualSecondsAdded,
          active_seconds_after: nextSeconds,
          event_type: 'heartbeat',
        })
    }

    return res.status(200).json({
      ok: true,
      reading_reward: publicReadingReward(updatedReward),
    })
  } catch (error) {
    console.error('TRACK READING REWARD ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to track reading reward',
      error: error.message,
    })
  }
}

export async function claimReadingReward(req, res) {
  try {
    const userId = getUserId(req)

    if (!userId) {
      return res.status(401).json({ ok: false, message: 'User is required' })
    }

    const reward = await getOrCreateReadingReward(userId)
    const publicReward = publicReadingReward(reward)
    const claimableMilestones = publicReward.milestones.filter((item) => item.claimable)
    const rewardCoins = claimableMilestones.reduce((sum, item) => sum + item.coins, 0)

    if (rewardCoins <= 0) {
      return res.status(400).json({
        ok: false,
        message: 'No reading reward available to claim',
        reading_reward: publicReward,
      })
    }

    const wallet = await getOrCreateWallet(userId)
    const now = new Date().toISOString()
    const nextClaimedMilestones = [
      ...new Set([
        ...publicReward.claimed_milestones,
        ...claimableMilestones.map((item) => item.seconds),
      ]),
    ].sort((a, b) => a - b)

    const { data: updatedReward, error: rewardError } = await supabase
      .from('reader_reading_rewards')
      .update({
        claimed_milestones: nextClaimedMilestones,
        updated_at: now,
      })
      .eq('id', reward.id)
      .select('*')
      .single()

    if (rewardError) throw rewardError

    const { data: updatedWallet, error: walletError } = await supabase
      .from('user_wallets')
      .update({
        gem_balance: Number(wallet.gem_balance || 0) + rewardCoins,
        updated_at: now,
      })
      .eq('user_id', userId)
      .select('*')
      .single()

    if (walletError) throw walletError

    const { data: historyItem, error: historyError } = await supabase
      .from('reader_reward_history')
      .insert({
        user_id: userId,
        source_key: 'reading_time_bonus',
        source_title: 'Read & Earn',
        amount_gems: rewardCoins,
        amount_vouchers: 0,
        story_cards: 0,
        metadata: {
          coins: rewardCoins,
          active_seconds: publicReward.active_seconds,
          claimed_milestones: claimableMilestones.map((item) => item.minutes),
        },
      })
      .select('*')
      .single()

    if (historyError) throw historyError

    return res.status(200).json({
      ok: true,
      wallet: publicWallet(updatedWallet),
      reading_reward: publicReadingReward(updatedReward),
      reward: {
        coins: rewardCoins,
        gems: rewardCoins,
      },
      history_item: historyItem ? publicHistoryItem(historyItem) : null,
      message: 'Reading reward claimed',
    })
  } catch (error) {
    console.error('CLAIM READING REWARD ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to claim reading reward',
      error: error.message,
    })
  }
}

export async function getTaskHistory(req, res) {
  try {
    const userId = getUserId(req)
    const { data, error } = await supabase
      .from('reader_reward_history')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(200)

    if (error) throw error

    const todayKey = getPhnomPenhDateKey()
    const weekStartDate = new Date(`${todayKey}T00:00:00.000Z`)
    weekStartDate.setUTCDate(weekStartDate.getUTCDate() - 6)
    const weekStartKey = weekStartDate.toISOString().slice(0, 10)
    const monthKey = todayKey.slice(0, 7)
    const yearKey = todayKey.slice(0, 4)

    const items = data || []

    function sumBy(filter) {
      return items
        .filter(filter)
        .reduce((total, item) => total + Number(item.amount_gems || 0), 0)
    }

    const summary = {
      today: sumBy((item) => getPhnomPenhDateKey(new Date(item.created_at)) === todayKey),
      this_week: sumBy((item) => {
        const key = getPhnomPenhDateKey(new Date(item.created_at))
        return key >= weekStartKey && key <= todayKey
      }),
      this_month: sumBy((item) => getPhnomPenhDateKey(new Date(item.created_at)).startsWith(monthKey)),
      this_year: sumBy((item) => getPhnomPenhDateKey(new Date(item.created_at)).startsWith(yearKey)),
      total: sumBy(() => true),
    }

    return res.status(200).json({
      ok: true,
      summary,
      history: items.map(publicHistoryItem),
    })
  } catch (error) {
    console.error('GET TASK HISTORY ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to load reward history',
      error: error.message,
    })
  }
}
