import { supabase } from '../config/supabase.js'

const MAX_REWARD_SECONDS = 1800
const MAX_SESSION_SECONDS = 30

function clampSeconds(value, limit) {
  const seconds = Math.floor(Number(value || 0))
  return Number.isFinite(seconds)
    ? Math.min(limit, Math.max(0, seconds))
    : 0
}

async function legacyReadingRewardProgress({
  userId,
  secondsToAdd,
  getOrCreateReadingReward,
}) {
  const reward = await getOrCreateReadingReward(userId)
  const previous = clampSeconds(reward.active_seconds, MAX_REWARD_SECONDS)
  const added = Math.min(MAX_REWARD_SECONDS - previous, secondsToAdd)

  if (added <= 0) {
    return { reward, secondsAdded: 0 }
  }

  const { data, error } = await supabase
    .from('reader_reading_rewards')
    .update({
      active_seconds: previous + added,
      updated_at: new Date().toISOString(),
    })
    .eq('id', reward.id)
    .select('*')
    .single()

  if (error) throw error
  return { reward: data, secondsAdded: added }
}

export async function recordReadingRewardSession({
  userId,
  rewardDate,
  seconds,
  getOrCreateReadingReward,
}) {
  const secondsToAdd = clampSeconds(seconds, MAX_SESSION_SECONDS)
  const { data, error } = await supabase.rpc(
    'record_reader_reading_reward_session',
    {
      p_user_id: userId,
      p_reward_date: rewardDate,
      p_seconds: secondsToAdd,
    }
  )

  if (error) {
    if (!['PGRST202', '42883'].includes(String(error.code || ''))) {
      throw error
    }

    return legacyReadingRewardProgress({
      userId,
      secondsToAdd,
      getOrCreateReadingReward,
    })
  }

  const result = Array.isArray(data) ? data[0] : data
  const reward = result?.reward
  const secondsAdded = Number(result?.seconds_added)

  if (
    !reward ||
    String(reward.user_id) !== String(userId) ||
    String(reward.reward_date).slice(0, 10) !== String(rewardDate) ||
    !Number.isInteger(secondsAdded) ||
    secondsAdded < 0 ||
    secondsAdded > secondsToAdd
  ) {
    throw new Error('Invalid atomic reading reward response')
  }

  return { reward, secondsAdded }
}
