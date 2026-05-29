import { supabase } from '../config/supabase.js'

const DAILY_REWARDS = [
  { day: 1, gems: 50, story_cards: 0 },
  { day: 2, gems: 100, story_cards: 0 },
  { day: 3, gems: 150, story_cards: 0 },
  { day: 4, gems: 200, story_cards: 0 },
  { day: 5, gems: 250, story_cards: 0 },
  { day: 6, gems: 300, story_cards: 0 },
  { day: 7, gems: 500, story_cards: 1 },
]

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

function publicWallet(wallet) {
  return {
    diamond_balance: Number(wallet?.diamond_balance || 0),
    gem_balance: Number(wallet?.gem_balance || 0),
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
    amount_diamonds: Number(item.amount_diamonds || 0),
    amount_vouchers: Number(item.amount_vouchers || 0),
    story_cards: Number(item.story_cards || 0),
    created_at: item.created_at,
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
    .insert({ user_id: userId, diamond_balance: 0, gem_balance: 0 })
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

  const nextGemBalance = Number(wallet.gem_balance || 0) + Number(reward.gems || 0)

  const { data: updatedWallet, error: walletError } = await supabase
    .from('user_wallets')
    .update({
      gem_balance: nextGemBalance,
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
      source_key: sourceKey,
      source_title: sourceKey === 'premium_auto_claim' ? 'Premium Auto Claim' : 'Daily Bonus',
      amount_gems: Number(reward.gems || 0),
      story_cards: Number(reward.story_cards || 0),
      metadata: {
        day: currentDay,
        streak_count: nextStreak,
      },
    })
    .select('*')
    .single()

  if (historyError) throw historyError

  return {
    already_claimed: false,
    wallet: updatedWallet,
    check_in: savedCheckIn,
    reward,
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
      message: result.already_claimed ? 'Already claimed today' : 'Daily bonus claimed',
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
