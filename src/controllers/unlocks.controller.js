import { createHash } from 'node:crypto'
import { supabase } from '../config/supabase.js'
import { createAuthorEarningsFromDiamondUnlock } from '../services/authorRevenue.service.js'
import { createStoryReadingIncomeSafely } from '../services/storyReadingIncome.service.js'
import { createAuthorStoryNotificationSafely } from '../services/authorStoryNotifications.service.js'
import {
  applyEpisodeAccess,
  getStoryEpisodeAccess,
} from '../services/episodeAccess.service.js'
import {
  getReaderAgeAccessByUserId,
  isStoryVisibleToReader,
} from '../services/storyAgeAccess.service.js'
import { applyBlackSundayDiscount } from '../services/blackSunday.service.js'
import { getWriterWednesdayEvent } from '../services/writerWednesday.service.js'
import { getAdditiveDiscountResult } from '../services/revenueRules.service.js'

const CAMBODIA_TIME_OFFSET_MS =
  7 * 60 * 60 * 1000

const FALLBACK_RULES = {
  diamond_per_episode: 10,
  gem_per_episode: 1000,
  gem_access_days: 7,
  gem_new_episode_wait_days: 7,
  standard_gem_daily_limit: 5,
  vip_gem_daily_limit: 10,
  premium_gem_daily_limit: 20,
  standard_gem_monthly_story_limit: 10,
  vip_gem_monthly_story_limit: 20,
  premium_gem_monthly_story_limit: 40,
  standard_free_first_episode_monthly_limit: 10,
  vip_free_first_episode_monthly_limit: 50,
  premium_free_first_episode_unlimited: true,
  voucher_cost_per_episode: 10,
  simple_story_card_cost_per_episode: 10,
  special_story_card_cost_per_episode: 1,
  view_count_cooldown_hours: 12,
  show_ads_after_free_unlock: true,
  free_unlock_ad_duration_seconds: 7,
  free_unlock_ad_close_after_seconds: 3,
}

const PACKAGE_RULES = {
  single: {
    key: 'single',
    label: '1 Episode',
    count: 1,
    discount_percent: 0,
    unlock_scope: 'single',
  },
  next10: {
    key: 'next10',
    label: 'Next 10 Eps',
    count: 10,
    discount_percent: 10,
    unlock_scope: 'next10',
  },
  next30: {
    key: 'next30',
    label: 'Next 30 Eps',
    count: 30,
    discount_percent: 20,
    unlock_scope: 'next30',
  },
  next50: {
    key: 'next50',
    label: 'Next 50 Eps',
    count: 50,
    discount_percent: 25,
    unlock_scope: 'next50',
  },
  all_released: {
    key: 'all_released',
    label: 'All Released Episodes',
    count: null,
    discount_percent: 40,
    unlock_scope: 'all_released',
  },
}

function publicWallet(wallet) {
  const coinBalance = Number(wallet?.gem_balance || 0)

  return {
    diamond_balance: Number(wallet?.diamond_balance || 0),
    gem_balance: coinBalance,
    coin_balance: coinBalance,
    voucher_balance: Number(wallet?.voucher_balance || 0),
    story_card_balance: Number(wallet?.story_card_balance || 0),
    auto_unlock: Boolean(wallet?.auto_unlock),
  }
}

function normalizeStoryStatus(story) {
  return String(story?.story_status || story?.completion_status || story?.novel_status || '').trim().toLowerCase()
}

function isStoryCompleted(story) {
  const status = normalizeStoryStatus(story)
  return status === 'completed' || status === 'complete' || status === 'finished' || status === 'ended'
}

function isEpisodeFree(episode, access = null) {
  return (
    Boolean(
      access?.freePublishedEpisodeIds?.has(
        String(episode?.id)
      )
    ) ||
    !episode?.is_locked
  )
}

function getPositiveInteger(value, fallback, max = 365) {
  const number = Number(value)

  if (!Number.isFinite(number) || number <= 0) return fallback

  return Math.min(Math.floor(number), max)
}

function formatWaitDuration(seconds) {
  const total = Math.max(0, Number(seconds || 0))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)

  if (days > 0) return `${days} days ${hours} hours`
  if (hours > 0) return `${hours} hours ${minutes} minutes`
  return `${minutes} minutes`
}

function formatUnlockDateTime(value) {
  const date = value ? new Date(value) : null

  if (!date || Number.isNaN(date.getTime())) return ''

  return date.toLocaleString('en-US', {
    timeZone: 'Asia/Phnom_Penh',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function getEpisodePublishedTime(episode) {
  const value = episode?.published_at || episode?.created_at
  const time = value ? new Date(value).getTime() : 0

  return Number.isFinite(time) ? time : 0
}

function getAutoFreeOldEpisodeLimit(story) {
  const totalEpisodes = Number(story?.total_episodes || 0)
  const maxEpisodes = getPositiveInteger(story?.auto_free_max_episodes, 5, 100)
  const maxPercent = getPositiveInteger(story?.auto_free_max_percent, 10, 100)
  const percentLimit = Math.ceil(totalEpisodes * (maxPercent / 100))

  return Math.max(0, Math.min(maxEpisodes, percentLimit))
}

function isAutoFreeOldEpisodeForStory(
  episode,
  story,
  access = null,
  now = Date.now()
) {
  if (!story?.auto_free_old_episodes_enabled) return false
  if (!episode?.is_locked) return false

  if (
    access?.freePublishedEpisodeIds?.has(
      String(episode?.id)
    )
  ) {
    return false
  }

  const publishedRank =
    access?.publishedRankById?.get(
      String(episode?.id)
    ) || 0

  if (publishedRank <= 5) return false

  const limit = getAutoFreeOldEpisodeLimit(story)

  if (limit <= 0) return false
  if (publishedRank > limit + 5) return false

  const publishedTime =
    getEpisodePublishedTime(episode)

  if (!publishedTime) return false

  const freeAfterDays = getPositiveInteger(
    story?.auto_free_after_days,
    30,
    365
  )
  const freeAfterMs =
    freeAfterDays * 24 * 60 * 60 * 1000

  return now - publishedTime >= freeAfterMs
}

function isEpisodeFreeForReader(
  episode,
  story,
  access = null,
  now = Date.now()
) {
  return (
    isEpisodeFree(episode, access) ||
    isAutoFreeOldEpisodeForStory(
      episode,
      story,
      access,
      now
    )
  )
}

function normalizeTier(value) {
  const tier = String(value || 'standard').trim().toLowerCase()

  if (tier === 'vip') return 'vip'
  if (tier === 'premium') return 'premium'

  return 'standard'
}

function getReaderTier(req) {
  return normalizeTier(req.user?.reader_tier || req.user?.subscription_tier || req.user?.membership_tier || req.user?.role)
}

function getEpisodeAdPolicy({ tier, unlock, freeEpisode }) {
  if (tier === 'premium') return { show_read_ad: false, reason: 'premium' }
  if (unlock?.unlock_type === 'diamond') return { show_read_ad: false, reason: 'diamond_unlock' }
  if (unlock?.unlock_type === 'ad') return { show_read_ad: false, reason: 'ad_unlock' }
  if (unlock?.unlock_type === 'gem' || unlock?.unlock_type === 'coin') return { show_read_ad: true, reason: 'coin_unlock' }
  if (freeEpisode) return { show_read_ad: true, reason: 'free_episode' }
  return { show_read_ad: true, reason: 'free_access' }
}

function publicReaderAdvertisement(item) {
  if (!item?.image_url) return null

  return {
    placement: item.placement,
    enabled: Boolean(item.enabled),
    image_url: item.image_url || '',
    link_url: item.link_url || '',
    duration_seconds: Number(item.duration_seconds || 0),
    close_after_seconds: Number(item.close_after_seconds || 0),
    frequency: item.frequency || 'every_unlock',
    updated_at: item.updated_at,
  }
}

async function getFreeUnlockAdvertisement() {
  const { data, error } = await supabase
    .from('shadow_advertisements')
    .select('placement, enabled, image_url, link_url, duration_seconds, close_after_seconds, frequency, updated_at')
    .eq('placement', 'freeUnlock')
    .eq('enabled', true)
    .maybeSingle()

  if (error) throw error

  return publicReaderAdvertisement(data)
}

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

function startOfMonthIso(date = new Date()) {
  const cambodiaDate = new Date(
    date.getTime() + CAMBODIA_TIME_OFFSET_MS
  )

  const localMonthStartUtc = Date.UTC(
    cambodiaDate.getUTCFullYear(),
    cambodiaDate.getUTCMonth(),
    1
  )

  return new Date(
    localMonthStartUtc - CAMBODIA_TIME_OFFSET_MS
  ).toISOString()
}

function getRuleNumber(rules, key) {
  return Number(rules?.[key] ?? FALLBACK_RULES[key])
}

function normalizeStoryCardType(value) {
  const type = String(value || 'simple').trim().toLowerCase()

  if (type === 'special') return 'special'

  return 'simple'
}

function getStoryCardCost(rules, cardType = 'simple') {
  if (cardType === 'special') {
    return getRuleNumber(rules, 'special_story_card_cost_per_episode')
  }

  return getRuleNumber(rules, 'simple_story_card_cost_per_episode')
}

function getGemDailyLimit(rules, tier) {
  if (tier === 'premium') return getRuleNumber(rules, 'premium_gem_daily_limit')
  if (tier === 'vip') return getRuleNumber(rules, 'vip_gem_daily_limit')
  return getRuleNumber(rules, 'standard_gem_daily_limit')
}

function getGemMonthlyStoryLimit(rules, tier) {
  if (tier === 'premium') return getRuleNumber(rules, 'premium_gem_monthly_story_limit')
  if (tier === 'vip') return getRuleNumber(rules, 'vip_gem_monthly_story_limit')
  return getRuleNumber(rules, 'standard_gem_monthly_story_limit')
}

function getEpisodeAvailableForGemAt(episode, rules, tier = 'standard') {
  if (tier === 'premium') {
    return {
      available: true,
      available_at: null,
      wait_seconds: 0,
      reason: 'premium',
    }
  }

  const waitDays = getRuleNumber(rules, 'gem_new_episode_wait_days')
  const publishedAt = episode?.published_at || episode?.created_at

  if (!publishedAt || waitDays <= 0) {
    return {
      available: true,
      available_at: null,
      wait_seconds: 0,
      reason: 'no_wait_required',
    }
  }

  const availableAtMs = new Date(publishedAt).getTime() + waitDays * 24 * 60 * 60 * 1000
  const nowMs = Date.now()
  const waitSeconds = Math.max(0, Math.ceil((availableAtMs - nowMs) / 1000))

  return {
    available: waitSeconds <= 0,
    available_at: new Date(availableAtMs).toISOString(),
    wait_seconds: waitSeconds,
    reason: waitSeconds <= 0 ? 'wait_finished' : 'wait_required',
  }
}

function calculateDiamondCost({
  count,
  packageDiscountPercent = 0,
  tier = 'standard',
  rules = FALLBACK_RULES,
}) {
  const original =
    Number(count || 0) *
    getRuleNumber(rules, 'diamond_per_episode')

  const packageDiscount = Math.max(
    0,
    Math.min(
      100,
      Number(packageDiscountPercent || 0)
    )
  )

  const premiumDiscount =
    tier === 'premium' ? 10 : 0

  const blackSunday =
    applyBlackSundayDiscount(original)

  const pricing = getAdditiveDiscountResult(
    original,
    [
      {
        key: 'package',
        label: 'Package',
        percent: packageDiscount,
      },
      {
        key: 'premium',
        label: 'Premium',
        percent: premiumDiscount,
      },
      {
        key: 'black_sunday',
        label: 'Black Sunday',
        percent: blackSunday.discount_percent,
        active: blackSunday.event.active,
      },
    ]
  )

  const total =
    original > 0
      ? Math.max(
          1,
          Math.ceil(pricing.final_paid_amount)
        )
      : 0

  return {
    original,
    package_price:
      original > 0
        ? Math.max(
            1,
            Math.ceil(
              original *
                ((100 - packageDiscount) / 100)
            )
          )
        : 0,
    total,
    discount_percent: packageDiscount,
    package_discount_percent:
      packageDiscount,
    premium_discount_percent:
      premiumDiscount,
    total_discount_percent:
      pricing.total_discount_percent,
    total_discount_amount:
      Math.max(0, original - total),
    applied_discounts:
      pricing.applied_discounts,
    black_sunday_active:
      blackSunday.event.active,
    black_sunday_discount_percent:
      blackSunday.discount_percent,
    black_sunday_discount_amount:
      Math.ceil(
        original *
          (blackSunday.discount_percent / 100)
      ),
    event: blackSunday.event,
  }
}

function calculateCoinCost(rules = FALLBACK_RULES) {
  const original = getRuleNumber(
    rules,
    'gem_per_episode'
  )
  const blackSunday =
    applyBlackSundayDiscount(original)

  return {
    original,
    total: blackSunday.amount,
    black_sunday_active:
      blackSunday.event.active,
    black_sunday_discount_percent:
      blackSunday.discount_percent,
    black_sunday_discount_amount:
      blackSunday.discount_amount,
    event: blackSunday.event,
  }
}

function publicPackageOption({
  rule,
  availableEpisodes,
  story,
  rules,
  tier = 'standard',
}) {
  const availableCount = availableEpisodes.length
  const requiredCount =
    rule.key === 'all_released'
      ? availableCount
      : Number(rule.count || 0)
  const canUseAllReleased =
    rule.key !== 'all_released' ||
    availableCount > 70 ||
    isStoryCompleted(story)
  const enabled =
    availableCount >= requiredCount &&
    requiredCount > 0 &&
    canUseAllReleased
  const cost = calculateDiamondCost({
    count: requiredCount,
    packageDiscountPercent:
      rule.discount_percent,
    tier,
    rules,
  })

  return {
    key: rule.key,
    label: rule.label,
    unlock_scope: rule.unlock_scope,
    requested_count: requiredCount,
    available_count: availableCount,
    enabled,
    disabled_reason: enabled
      ? ''
      : rule.key === 'all_released'
        ? 'All Released Episodes works when the story has more than 70 released locked episodes or the story is completed.'
        : `This story does not have ${requiredCount} locked released episodes available from this point.`,
    discount_percent:
      cost.total_discount_percent,
    package_discount_percent:
      cost.package_discount_percent,
    premium_discount_percent:
      cost.premium_discount_percent,
    total_discount_percent:
      cost.total_discount_percent,
    total_discount_amount:
      cost.total_discount_amount,
    applied_discounts:
      cost.applied_discounts,
    original_price: cost.original,
    package_price: cost.package_price,
    price: cost.total,
    black_sunday_active:
      cost.black_sunday_active,
    black_sunday_discount_percent:
      cost.black_sunday_discount_percent,
    black_sunday_discount_amount:
      cost.black_sunday_discount_amount,
    event: cost.event,
    currency: 'diamond',
    episode_ids: enabled
      ? availableEpisodes
          .slice(0, requiredCount)
          .map((episode) => episode.id)
      : [],
  }
}

async function getPlatformUnlockRules() {
  const { data, error } = await supabase
    .from('platform_unlock_rules')
    .select('*')
    .eq('id', 1)
    .maybeSingle()

  if (error) return FALLBACK_RULES
  return data || FALLBACK_RULES
}

async function getStory(storyId) {
  const { data, error } = await supabase
    .from('stories')
    .select('*')
    .eq('id', storyId)
    .maybeSingle()

  if (error) throw error
  return data
}

async function getEpisode({ storyId, episodeId }) {
  const { data, error } = await supabase
    .from('episodes')
    .select('id, story_id, author_id, user_id, title, episode_number, is_locked, status, published_at, created_at')
    .eq('id', episodeId)
    .eq('story_id', storyId)
    .maybeSingle()

  if (error) throw error
  return data
}

async function getWallet(userId) {
  const { data: wallet, error } = await supabase
    .from('user_wallets')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  if (wallet) return wallet

  const { data: createdWallet, error: createError } = await supabase
    .from('user_wallets')
    .insert({ user_id: userId })
    .select()
    .single()

  if (createError) throw createError
  return createdWallet
}

async function getActiveUnlock({ userId, episodeId }) {
  const { data, error } = await supabase
    .from('episode_unlocks')
    .select('*')
    .eq('user_id', userId)
    .eq('episode_id', episodeId)
    .eq('unlock_status', 'active')
    .maybeSingle()

  if (error) throw error

  if (data?.expires_at && new Date(data.expires_at).getTime() < Date.now()) {
    return null
  }

  return data
}

async function getReaderProfileSafely(userId) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, name, username, avatar_url')
      .eq('id', userId)
      .maybeSingle()

    if (error) throw error
    return data || null
  } catch (error) {
    console.error('GET UNLOCK READER PROFILE ERROR:', error)
    return null
  }
}

async function getActiveUnlockEpisodeIds({ userId, storyId }) {
  if (!userId || !storyId) return new Set()

  const { data, error } = await supabase
    .from('episode_unlocks')
    .select('episode_id, expires_at')
    .eq('user_id', userId)
    .eq('story_id', storyId)
    .eq('unlock_status', 'active')

  if (error) throw error

  return new Set(
    (data || [])
      .filter((item) => !item.expires_at || new Date(item.expires_at).getTime() >= Date.now())
      .map((item) => item.episode_id)
  )
}

async function getAvailableLockedEpisodes({
  userId,
  storyId,
  fromEpisodeNumber,
  access,
}) {
  const unlockedIds =
    await getActiveUnlockEpisodeIds({
      userId,
      storyId,
    })

  const { data, error } = await supabase
    .from('episodes')
    .select(
      'id, story_id, author_id, title, episode_number, is_locked, status, published_at, created_at'
    )
    .eq('story_id', storyId)
    .eq('status', 'published')
    .eq('is_locked', true)
    .is('deleted_at', null)
    .order('episode_number', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) throw error

  return (data || [])
    .map((episode) =>
      applyEpisodeAccess(episode, access)
    )
    .filter(
      (episode) =>
        Number(episode.episode_number || 0) >=
        Number(fromEpisodeNumber || 1)
    )
    .filter(
      (episode) => !episode.is_free_published
    )
    .filter(
      (episode) => !unlockedIds.has(episode.id)
    )
}

async function countGemUnlocksToday(userId) {
  const { count, error } = await supabase
    .from('episode_unlock_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('currency', 'gem')
    .gte('created_at', startOfTodayIso())

  if (error) throw error
  return Number(count || 0)
}

async function countGemUnlocksThisMonthForStory({ userId, storyId }) {
  const { count, error } = await supabase
    .from('episode_unlock_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('story_id', storyId)
    .eq('currency', 'gem')
    .gte('created_at', startOfMonthIso())

  if (error) throw error
  return Number(count || 0)
}

async function getGemLimitStatus({ userId, storyId, tier, rules }) {
  const [dailyUsed, monthlyStoryUsed] = await Promise.all([
    countGemUnlocksToday(userId),
    countGemUnlocksThisMonthForStory({ userId, storyId }),
  ])

  const dailyLimit = getGemDailyLimit(rules, tier)
  const monthlyStoryLimit = getGemMonthlyStoryLimit(rules, tier)

  return {
    tier,
    daily: {
      used: dailyUsed,
      limit: dailyLimit,
      remaining: Math.max(0, dailyLimit - dailyUsed),
      allowed: dailyUsed < dailyLimit,
    },
    monthly_story: {
      used: monthlyStoryUsed,
      limit: monthlyStoryLimit,
      remaining: Math.max(0, monthlyStoryLimit - monthlyStoryUsed),
      allowed: monthlyStoryUsed < monthlyStoryLimit,
    },
  }
}

async function getUnlockStatusPayload({
  userId,
  storyId,
  episodeId,
  tier = 'standard',
}) {
  const [
    rules,
    story,
    rawEpisode,
    wallet,
    access,
  ] = await Promise.all([
    getPlatformUnlockRules(),
    getStory(storyId),
    getEpisode({ storyId, episodeId }),
    getWallet(userId),
    getStoryEpisodeAccess(storyId),
  ])

  if (!story || !rawEpisode) {
    return {
      notFound: true,
    }
  }
const ageAccess =
  await getReaderAgeAccessByUserId(userId)

if (!isStoryVisibleToReader(story, ageAccess)) {
  return {
    notFound: true,
  }
}
  const episode = applyEpisodeAccess(
    rawEpisode,
    access
  )
  const unlock = await getActiveUnlock({
    userId,
    episodeId,
  })
  const freeEpisode = isEpisodeFreeForReader(
    episode,
    story,
    access
  )
  const unlocked =
    freeEpisode || Boolean(unlock)
  const availableEpisodes =
    await getAvailableLockedEpisodes({
      userId,
      storyId,
      fromEpisodeNumber:
        episode.episode_number,
      access,
    })
  const gemWait = getEpisodeAvailableForGemAt(
    episode,
    rules,
    tier
  )
  const gemLimits = await getGemLimitStatus({
    userId,
    storyId,
    tier,
    rules,
  })

  return {
    notFound: false,
    rules,
    story,
    episode,
    wallet,
    unlock,
    freeEpisode,
    unlocked,
    availableEpisodes,
    gemWait,
    gemLimits,
    packageOptions: [
      publicPackageOption({
        rule: PACKAGE_RULES.single,
        availableEpisodes,
        story,
        rules,
        tier,
      }),
      publicPackageOption({
        rule: PACKAGE_RULES.next10,
        availableEpisodes,
        story,
        rules,
        tier,
      }),
      publicPackageOption({
        rule: PACKAGE_RULES.next30,
        availableEpisodes,
        story,
        rules,
        tier,
      }),
      publicPackageOption({
        rule: PACKAGE_RULES.next50,
        availableEpisodes,
        story,
        rules,
        tier,
      }),
      publicPackageOption({
        rule: PACKAGE_RULES.all_released,
        availableEpisodes,
        story,
        rules,
        tier,
      }),
    ],
  }
}

async function updateGemBalance({ userId, wallet, amount }) {
  const nextGemBalance = Number(wallet.gem_balance || 0) - Number(amount || 0)

  const { data, error } = await supabase
    .from('user_wallets')
    .update({
      gem_balance: nextGemBalance,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .select()
    .single()

  if (error) throw error
  return data
}

async function updateVoucherBalance({ userId, wallet, amount }) {
  const nextVoucherBalance = Number(wallet.voucher_balance || 0) - Number(amount || 0)

  const { data, error } = await supabase
    .from('user_wallets')
    .update({
      voucher_balance: nextVoucherBalance,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .select()
    .single()

  if (error) throw error
  return data
}

async function updateStoryCardBalance({ userId, wallet, amount }) {
  const nextStoryCardBalance = Number(wallet.story_card_balance || 0) - Number(amount || 0)

  const { data, error } = await supabase
    .from('user_wallets')
    .update({
      story_card_balance: nextStoryCardBalance,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .select()
    .single()

  if (error) throw error
  return data
}

async function getAuthorEarningsForTransactions(
  transactions
) {
  const transactionIds = (transactions || [])
    .map((transaction) => transaction?.id)
    .filter(Boolean)

  if (!transactionIds.length) return []

  const { data, error } = await supabase
    .from('author_earnings')
    .select('*')
    .in('unlock_transaction_id', transactionIds)

  if (error) throw error

  return data || []
}

async function recordDiamondUnlockAccounting({
  purchaseKey,
  userId,
  storyId,
  episodes,
  transactions,
  transactionAmount,
  unlockScope,
  metadata,
}) {
  if (!transactions?.length) return []

  const createdEarnings =
    await createAuthorEarningsFromDiamondUnlock({
      transactions,
    })

  const earningRows = Array.isArray(createdEarnings) &&
    createdEarnings.length
    ? createdEarnings
    : await getAuthorEarningsForTransactions(
        transactions
      )

  if (!earningRows.length) {
    throw new Error(
      'Diamond unlock earnings were not created'
    )
  }

  const firstEarning = earningRows[0]
  const authorEarnedDiamonds = earningRows.reduce(
    (sum, row) =>
      sum + Number(row.author_earned_diamonds || 0),
    0
  )
  const platformEarnedDiamonds = earningRows.reduce(
    (sum, row) =>
      sum + Number(row.platform_earned_diamonds || 0),
    0
  )
  const distributableNetRevenueDiamonds =
    earningRows.reduce(
      (sum, row) =>
        sum + Number(row.net_paid_diamonds || 0),
      0
    )
  const directCostDiamonds = Math.max(
    0,
    Number(transactionAmount || 0) -
      distributableNetRevenueDiamonds
  )

  await createStoryReadingIncomeSafely({
    purchaseKey: `diamond-unlock:${purchaseKey}`,
    readerId: userId,
    storyId,
    authorId: episodes[0]?.author_id || null,
    firstEpisodeId: episodes[0]?.id || null,
    packageKey:
      metadata?.package_key ||
      unlockScope ||
      'single',
    episodeCount: episodes.length,
    originalDiamonds:
      metadata?.original_price ||
      transactionAmount,
    packageDiscountPercent:
      metadata?.package_discount_percent ??
      metadata?.discount_percent ??
      0,
    blackSundayDiscountPercent:
      metadata?.black_sunday_discount_percent || 0,
    paidDiamonds: transactionAmount,
    authorSharePercent:
      firstEarning.author_share_percent,
    shareSource: firstEarning.share_source,
    authorEarnedDiamonds,
    platformEarnedDiamonds,
    directCostDiamonds,
    distributableNetRevenueDiamonds,
    metadata: {
      ...metadata,
      purchase_key: purchaseKey,
      revenue_source: 'author_earnings',
      effective_author_share_percent: Number(
        firstEarning.author_share_percent || 0
      ),
      effective_share_source:
        firstEarning.share_source || '',
    },
  })

  return earningRows
}

function allocateEpisodeAmounts(totalAmount, episodes) {
  const total = Math.max(
    0,
    Math.floor(Number(totalAmount || 0))
  )
  const count = episodes.length

  if (!count) return []

  const baseAmount = Math.floor(total / count)
  const remainder = total % count

  return episodes.map((episode, index) => ({
    episode_id: episode.id,
    author_id: episode.author_id,
    episode_number:
      Number(episode.episode_number || 0),
    episode_title: episode.title || '',
    allocated_amount:
      baseAmount + (index < remainder ? 1 : 0),
  }))
}

function buildDiamondPurchaseKey({
  userId,
  storyId,
  episodeId,
  packageKey,
}) {
  return createHash('sha256')
    .update(
      [
        'diamond-unlock-v1',
        userId,
        storyId,
        episodeId,
        packageKey,
      ].join(':')
    )
    .digest('hex')
}

async function getCompletedDiamondPurchase({
  userId,
  purchaseKey,
}) {
  const { data: request, error: requestError } =
    await supabase
      .from('episode_unlock_purchase_requests')
      .select('*')
      .eq('user_id', userId)
      .eq('purchase_key', purchaseKey)
      .eq('status', 'completed')
      .maybeSingle()

  if (requestError) throw requestError
  if (!request) return null

  const { data: transactions, error: transactionError } =
    await supabase
      .from('episode_unlock_transactions')
      .select('*')
      .eq('user_id', userId)
      .eq('currency', 'diamond')
      .eq('transaction_type', 'unlock')
      .contains('metadata', {
        purchase_key: purchaseKey,
      })
      .order('created_at', { ascending: true })

  if (transactionError) throw transactionError

  const episodeIds = (transactions || [])
    .map((transaction) => transaction.episode_id)
    .filter(Boolean)

  let unlocks = []

  if (episodeIds.length) {
    const { data, error } = await supabase
      .from('episode_unlocks')
      .select('*')
      .eq('user_id', userId)
      .in('episode_id', episodeIds)

    if (error) throw error
    unlocks = data || []
  }

  const { data: wallet, error: walletError } =
    await supabase
      .from('user_wallets')
      .select('*')
      .eq('user_id', userId)
      .single()

  if (walletError) throw walletError

  return {
    request,
    wallet,
    unlocks,
    transactions: transactions || [],
  }
}

async function commitDiamondUnlockPurchase({
  userId,
  purchaseKey,
  storyId,
  episodes,
  unlockScope,
  transactionAmount,
  metadata,
}) {
  const episodeRows = allocateEpisodeAmounts(
    transactionAmount,
    episodes
  )

  const { data, error } = await supabase.rpc(
    'commit_diamond_episode_unlock_purchase',
    {
      p_user_id: userId,
      p_purchase_key: purchaseKey,
      p_story_id: storyId,
      p_amount: transactionAmount,
      p_unlock_scope: unlockScope,
      p_episodes: episodeRows,
      p_metadata: metadata || {},
    }
  )

  if (error) throw error

  return {
    idempotent: Boolean(data?.idempotent),
    wallet: data?.wallet || null,
    unlocks: Array.isArray(data?.unlocks)
      ? data.unlocks
      : [],
    transactions: Array.isArray(data?.transactions)
      ? data.transactions
      : [],
  }
}

async function createUnlocksAndTransactions({
  userId,
  storyId,
  episodes,
  unlockType,
  unlockScope,
  accessType,
  expiresAt,
  diamondSpent,
  transactionCurrency,
  transactionAmount,
  metadata,
}) {
  if (!episodes.length) return []

  if (transactionCurrency === 'diamond') {
    throw new Error(
      'Diamond unlocks must use the atomic purchase function'
    )
  }

  const unlockRows = episodes.map((episode) => ({
    user_id: userId,
    story_id: storyId,
    episode_id: episode.id,
    author_id: episode.author_id,
    unlock_type: unlockType,
    unlock_scope: unlockScope,
    access_type: accessType,
    expires_at: expiresAt,
    diamond_spent: diamondSpent,
    unlock_status: 'active',
  }))

  const { data: unlocks, error: unlockError } =
    await supabase
      .from('episode_unlocks')
      .upsert(unlockRows, {
        onConflict: 'user_id,episode_id',
      })
      .select()

  if (unlockError) throw unlockError

  const unlockMap = new Map(
    (unlocks || []).map((unlock) => [
      unlock.episode_id,
      unlock.id,
    ])
  )
  const totalTransactionAmount = Math.max(
    0,
    Math.floor(Number(transactionAmount || 0))
  )
  const baseAmount =
    episodes.length > 0
      ? Math.floor(
          totalTransactionAmount / episodes.length
        )
      : 0
  const remainderAmount =
    episodes.length > 0
      ? totalTransactionAmount % episodes.length
      : 0

  const transactionRows = episodes.map(
    (episode, index) => ({
      unlock_id:
        unlockMap.get(episode.id) || null,
      user_id: userId,
      story_id: storyId,
      episode_id: episode.id,
      author_id: episode.author_id,
      currency: transactionCurrency,
      amount:
        baseAmount +
        (index < remainderAmount ? 1 : 0),
      transaction_type: 'unlock',
      metadata: {
        ...metadata,
        episode_number: episode.episode_number,
        episode_title: episode.title,
        package_total_amount:
          transactionAmount,
      },
    })
  )

  const {
    data: transactions,
    error: transactionError,
  } = await supabase
    .from('episode_unlock_transactions')
    .insert(transactionRows)
    .select()

  if (transactionError) throw transactionError

  return unlocks || []
}
export function getWriterWednesdayStatus(req, res) {
  return res.status(200).json({
    ok: true,
    event: getWriterWednesdayEvent(),
  })
}

export async function getEpisodeUnlockStatus(req, res) {
  try {
    const userId = req.user?.user_id
    const { storyId, episodeId } = req.params
    const tier = getReaderTier(req)

    const payload = await getUnlockStatusPayload({ userId, storyId, episodeId, tier })

    if (payload.notFound) {
      return res.status(404).json({
        ok: false,
        message: 'Episode not found',
      })
    }

    const adPolicy = getEpisodeAdPolicy({
  tier,
  unlock: payload.unlock,
  freeEpisode: payload.freeEpisode,
})

const readerAdvertisement = adPolicy.show_read_ad ? await getFreeUnlockAdvertisement() : null

const coinCost =
  calculateCoinCost(payload.rules)

const singleDiamondOption =
  payload.packageOptions.find(
    (item) => item.key === 'single'
  ) || null

    return res.status(200).json({
      ok: true,
      locked: !payload.unlocked,
      unlocked: payload.unlocked,
      free_episode: payload.freeEpisode,
      unlock_type: payload.freeEpisode ? 'free' : payload.unlock?.unlock_type || null,
            price: {
        currency: 'diamond',
        amount:
          singleDiamondOption?.price ||
          getRuleNumber(
            payload.rules,
            'diamond_per_episode'
          ),
        original_amount:
          singleDiamondOption?.original_price ||
          getRuleNumber(
            payload.rules,
            'diamond_per_episode'
          ),
        package_discount_percent:
          singleDiamondOption
            ?.package_discount_percent || 0,
        premium_discount_percent:
          singleDiamondOption
            ?.premium_discount_percent || 0,
        total_discount_percent:
          singleDiamondOption
            ?.total_discount_percent || 0,
        total_discount_amount:
          singleDiamondOption
            ?.total_discount_amount || 0,
        applied_discounts:
          singleDiamondOption?.applied_discounts || [],
        black_sunday_active: Boolean(
          singleDiamondOption?.black_sunday_active
        ),
        black_sunday_discount_percent:
          singleDiamondOption
            ?.black_sunday_discount_percent || 0,
        black_sunday_discount_amount:
          singleDiamondOption
            ?.black_sunday_discount_amount || 0,
        event:
          singleDiamondOption?.event || null,
      },
          gem_access: {
  currency: 'gem',
  display_currency: 'coin',
  amount: coinCost.total,
  original_amount: coinCost.original,
  coin_amount: coinCost.total,
  original_coin_amount: coinCost.original,
  black_sunday_active:
    coinCost.black_sunday_active,
  black_sunday_discount_percent:
    coinCost.black_sunday_discount_percent,
  black_sunday_discount_amount:
    coinCost.black_sunday_discount_amount,
  event: coinCost.event,
  access_days: getRuleNumber(payload.rules, 'gem_access_days'),
  coin_access_days: getRuleNumber(payload.rules, 'gem_access_days'),
  available: payload.gemWait.available && payload.gemLimits.daily.allowed && payload.gemLimits.monthly_story.allowed,
  available_at: payload.gemWait.available_at,
  wait_seconds: payload.gemWait.wait_seconds,
  limit_status: payload.gemLimits,
},
coin_access: {
  currency: 'coin',
  amount: coinCost.total,
  original_amount: coinCost.original,
  black_sunday_active:
    coinCost.black_sunday_active,
  black_sunday_discount_percent:
    coinCost.black_sunday_discount_percent,
  black_sunday_discount_amount:
    coinCost.black_sunday_discount_amount,
  event: coinCost.event,
  access_days: getRuleNumber(payload.rules, 'gem_access_days'),
  available: payload.gemWait.available && payload.gemLimits.daily.allowed && payload.gemLimits.monthly_story.allowed,
  available_at: payload.gemWait.available_at,
  wait_seconds: payload.gemWait.wait_seconds,
  limit_status: payload.gemLimits,
},
voucher_access: {
  currency: 'voucher',
  amount: getRuleNumber(payload.rules, 'voucher_cost_per_episode'),
  access_type: 'permanent',
  available: payload.gemWait.available,
  available_at: payload.gemWait.available_at,
  wait_seconds: payload.gemWait.wait_seconds,
},

      story_card_access: {
  currency: 'story_card',
  amount: getStoryCardCost(payload.rules, 'simple'),
  simple_amount: getStoryCardCost(payload.rules, 'simple'),
  special_amount: getStoryCardCost(payload.rules, 'special'),
  access_type: 'permanent',
  available: payload.gemWait.available,
  available_at: payload.gemWait.available_at,
  wait_seconds: payload.gemWait.wait_seconds,
},

      ad_access: {
  currency: 'ad',
  amount: 1,
  access_days: getRuleNumber(payload.rules, 'gem_access_days'),
  access_type: 'temporary',
  available: payload.gemWait.available,
  available_at: payload.gemWait.available_at,
  wait_seconds: payload.gemWait.wait_seconds,
},
      
      package_options: payload.packageOptions,
      story_unlock_rules: {
        completed: isStoryCompleted(payload.story),
        all_released_minimum_episodes: 70,
      },
      wallet: publicWallet(payload.wallet),
      ad_policy: adPolicy,
advertisement: readerAdvertisement,
    })
  } catch (error) {
    console.error('GET EPISODE UNLOCK STATUS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to check unlock status',
      error: error.message,
    })
  }
}

export async function unlockEpisodeWithDiamonds(req, res) {
  try {
    const reqWithPackage = {
      ...req,
      body: {
        ...req.body,
        package_key: 'single',
      },
    }

    return unlockEpisodePackageWithDiamonds(reqWithPackage, res)
  } catch (error) {
    console.error('UNLOCK EPISODE WITH DIAMONDS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to unlock episode',
      error: error.message,
    })
  }
}

export async function unlockEpisodePackageWithDiamonds(
  req,
  res
) {
  const userId = req.user?.user_id
  const { storyId, episodeId } = req.params
  const tier = getReaderTier(req)
  const packageKey = String(
    req.body.package_key ||
      req.body.packageKey ||
      'single'
  ).trim()
  const rule = PACKAGE_RULES[packageKey]

  if (!rule) {
    return res.status(400).json({
      ok: false,
      message: 'Unlock package is not valid',
    })
  }

  const purchaseKey = buildDiamondPurchaseKey({
    userId,
    storyId,
    episodeId,
    packageKey,
  })

  try {
    const completedPurchase =
      await getCompletedDiamondPurchase({
        userId,
        purchaseKey,
      })

    if (completedPurchase) {
      const transactions =
        completedPurchase.transactions

      if (!transactions.length) {
        throw new Error(
          'Completed purchase transactions were not found'
        )
      }
      const episodes = transactions.map(
        (transaction) => ({
          id: transaction.episode_id,
          author_id: transaction.author_id,
          episode_number:
            transaction.metadata?.episode_number,
          title:
            transaction.metadata?.episode_title,
        })
      )
      const metadata =
        transactions[0]?.metadata || {}

      await recordDiamondUnlockAccounting({
        purchaseKey,
        userId,
        storyId,
        episodes,
        transactions,
        transactionAmount:
          completedPurchase.request.amount,
        unlockScope:
          completedPurchase.request.unlock_scope,
        metadata,
      })

      return res.status(200).json({
        ok: true,
        message: 'Episodes unlocked successfully',
        unlocked: true,
        idempotent: true,
        package_key: packageKey,
        unlocked_count:
          completedPurchase.unlocks.length,
        unlocked_episode_ids:
          completedPurchase.unlocks.map(
            (unlock) => unlock.episode_id
          ),
        wallet: publicWallet(
          completedPurchase.wallet
        ),
      })
    }

    const payload = await getUnlockStatusPayload({
      userId,
      storyId,
      episodeId,
      tier,
    })

    if (payload.notFound) {
      return res.status(404).json({
        ok: false,
        message: 'Episode not found',
      })
    }

    if (payload.freeEpisode || payload.unlocked) {
      return res.status(200).json({
        ok: true,
        message: 'Episode already unlocked',
        unlocked: true,
        wallet: publicWallet(payload.wallet),
      })
    }

    const option = payload.packageOptions.find(
      (item) => item.key === packageKey
    )

    if (!option?.enabled) {
      return res.status(400).json({
        ok: false,
        code: 'PACKAGE_NOT_AVAILABLE',
        message:
          option?.disabled_reason ||
          'This package is not available',
        option,
        package_options: payload.packageOptions,
        wallet: publicWallet(payload.wallet),
      })
    }

    if (
      Number(payload.wallet.diamond_balance || 0) <
      Number(option.price || 0)
    ) {
      return res.status(402).json({
        ok: false,
        code: 'INSUFFICIENT_DIAMONDS',
        message: 'Not enough Diamonds',
        need:
          Number(option.price || 0) -
          Number(
            payload.wallet.diamond_balance || 0
          ),
        price: Number(option.price || 0),
        option,
        wallet: publicWallet(payload.wallet),
      })
    }

    const episodesToUnlock =
      payload.availableEpisodes.slice(
        0,
        option.requested_count
      )

    const writerWednesday =
  getWriterWednesdayEvent()
    const metadata = {
      purchase_key: purchaseKey,
      package_key: packageKey,
      package_label: option.label,
      episode_count: episodesToUnlock.length,
      discount_percent:
        option.total_discount_percent,
      package_discount_percent:
        option.package_discount_percent,
      premium_discount_percent:
        option.premium_discount_percent,
      total_discount_percent:
        option.total_discount_percent,
      total_discount_amount:
        option.total_discount_amount,
      applied_discounts:
        option.applied_discounts,
      original_price: option.original_price,
      package_price: option.package_price,
      final_price: option.price,
      black_sunday_active:
        option.black_sunday_active,
      black_sunday_discount_percent:
        option.black_sunday_discount_percent,
      black_sunday_discount_amount:
        option.black_sunday_discount_amount,
      event_key: writerWednesday.active
  ? writerWednesday.key
  : option.event?.key || '',
event_time_zone: writerWednesday.active
  ? writerWednesday.time_zone
  : option.event?.time_zone || '',
event_author_share_percent:
  writerWednesday.author_share_percent,
writer_wednesday_active:
  writerWednesday.active,
writer_wednesday_author_share_percent:
  writerWednesday.author_share_percent,
writer_wednesday_platform_share_percent:
  writerWednesday.platform_share_percent,
writer_wednesday_time_zone:
  writerWednesday.time_zone,
reader_tier: tier,
    }

    const purchase =
      await commitDiamondUnlockPurchase({
        userId,
        purchaseKey,
        storyId,
        episodes: episodesToUnlock,
        unlockScope: rule.unlock_scope,
        transactionAmount: option.price,
        metadata,
      })

    await recordDiamondUnlockAccounting({
      purchaseKey,
      userId,
      storyId,
      episodes: episodesToUnlock,
      transactions: purchase.transactions,
      transactionAmount: option.price,
      unlockScope: rule.unlock_scope,
      metadata,
    })

    const reader =
      await getReaderProfileSafely(userId)
    const readerName =
      reader?.name ||
      reader?.username ||
      'A reader'
    const firstEpisode = episodesToUnlock[0]
    const isOwner =
      String(payload.story.user_id || '') ===
      String(userId)

    if (
      !isOwner &&
      payload.story.author_id &&
      purchase.unlocks.length
    ) {
      await createAuthorStoryNotificationSafely({
        authorId: payload.story.author_id,
        type: 'unlock',
        title:
          `${readerName} unlocked ` +
          `${purchase.unlocks.length} episode` +
          `${purchase.unlocks.length > 1 ? 's' : ''}`,
        message:
          `${option.price} Diamonds spent on ` +
          `${payload.story.title || 'your story'}`,
        targetUrl:
          `/story/${storyId}/episode/` +
          `${firstEpisode?.id || episodeId}`,
        sourceKey:
          `diamond-unlock:${purchaseKey}`,
        metadata: {
          story_id: storyId,
          episode_id:
            firstEpisode?.id || episodeId,
          unlock_ids: purchase.unlocks.map(
            (unlock) => unlock.id
          ),
          purchase_key: purchaseKey,
          package_key: packageKey,
          episode_count:
            purchase.unlocks.length,
          diamond_amount:
            Number(option.price || 0),
          reader_id: userId,
          reader_name: readerName,
          reader_username:
            reader?.username || '',
          reader_avatar_url:
            reader?.avatar_url || '',
        },
      })
    }

    return res.status(200).json({
      ok: true,
      message: 'Episodes unlocked successfully',
      unlocked: true,
      idempotent: purchase.idempotent,
      package_key: packageKey,
      unlocked_count: purchase.unlocks.length,
      unlocked_episode_ids:
        purchase.unlocks.map(
          (unlock) => unlock.episode_id
        ),
      wallet: publicWallet(purchase.wallet),
    })
  } catch (error) {
    console.error(
      'UNLOCK EPISODE PACKAGE WITH DIAMONDS ERROR:',
      error
    )

    const errorMessage = String(
      error?.message || ''
    )

    if (
      errorMessage.includes(
        'INSUFFICIENT_DIAMONDS'
      )
    ) {
      const wallet = await getWallet(userId)

      return res.status(402).json({
        ok: false,
        code: 'INSUFFICIENT_DIAMONDS',
        message: 'Not enough Diamonds',
        wallet: publicWallet(wallet),
      })
    }

    if (
      errorMessage.includes('PURCHASE_KEY_REUSED') ||
      errorMessage.includes('PURCHASE_IN_PROGRESS')
    ) {
      return res.status(409).json({
        ok: false,
        code: 'PURCHASE_CONFLICT',
        message:
          'This purchase is already being processed. Please try again.',
      })
    }

    return res.status(500).json({
      ok: false,
      code: 'DIAMOND_UNLOCK_FAILED',
      message: 'Failed to unlock episodes',
      error: error.message,
    })
  }
}

export async function unlockEpisodeWithGems(req, res) {
  try {
    const userId = req.user?.user_id
    const { storyId, episodeId } = req.params
    const tier = getReaderTier(req)

    const payload = await getUnlockStatusPayload({ userId, storyId, episodeId, tier })

    if (payload.notFound) {
      return res.status(404).json({
        ok: false,
        message: 'Episode not found',
      })
    }

    if (payload.freeEpisode || payload.unlocked) {
      return res.status(200).json({
        ok: true,
        message: 'Episode already unlocked',
        unlocked: true,
        wallet: publicWallet(payload.wallet),
      })
    }

    if (!payload.gemWait.available) {
      const waitText = formatWaitDuration(
        payload.gemWait.wait_seconds
      )
      const unlockDateText = formatUnlockDateTime(
        payload.gemWait.available_at
      )
      const waitCoinCost =
        calculateCoinCost(payload.rules)

      return res.status(403).json({
        ok: false,
        code: 'COIN_WAIT_REQUIRED',
        legacy_code: 'GEM_WAIT_REQUIRED',
        message: `This episode is newly released. Coin access will be available in ${waitText}.${unlockDateText ? ` Unlocks on ${unlockDateText}.` : ''}`,
        available_at:
          payload.gemWait.available_at,
        wait_seconds:
          payload.gemWait.wait_seconds,
        coin_access: {
          amount: waitCoinCost.total,
          original_amount:
            waitCoinCost.original,
          black_sunday_active:
            waitCoinCost.black_sunday_active,
          black_sunday_discount_percent:
            waitCoinCost.black_sunday_discount_percent,
          access_days: getRuleNumber(
            payload.rules,
            'gem_access_days'
          ),
        },
        gem_access: {
          amount: waitCoinCost.total,
          original_amount:
            waitCoinCost.original,
          black_sunday_active:
            waitCoinCost.black_sunday_active,
          black_sunday_discount_percent:
            waitCoinCost.black_sunday_discount_percent,
          access_days: getRuleNumber(
            payload.rules,
            'gem_access_days'
          ),
        },
        wallet: publicWallet(payload.wallet),
      })
    }

    if (!payload.gemLimits.daily.allowed) {
      return res.status(403).json({
        ok: false,
        code: 'GEM_DAILY_LIMIT_REACHED',
        message: `You reached your daily Coin unlock limit for ${tier} readers.`,
        limit_status: payload.gemLimits,
        wallet: publicWallet(payload.wallet),
      })
    }

    if (!payload.gemLimits.monthly_story.allowed) {
      return res.status(403).json({
        ok: false,
        code: 'GEM_MONTHLY_STORY_LIMIT_REACHED',
        message: 'You reached your monthly Coin unlock limit for this story.',
        limit_status: payload.gemLimits,
        wallet: publicWallet(payload.wallet),
      })
    }

    const coinCost =
      calculateCoinCost(payload.rules)
    const gemPrice = coinCost.total
    const accessDays = getRuleNumber(
      payload.rules,
      'gem_access_days'
    )

    if (Number(payload.wallet.gem_balance || 0) < gemPrice) {
      return res.status(402).json({
        ok: false,
        code: 'INSUFFICIENT_COINS',
        legacy_code: 'INSUFFICIENT_GEMS',
        message: 'Not enough Coins',
        need:
          gemPrice -
          Number(
            payload.wallet.gem_balance || 0
          ),
        price: gemPrice,
        original_price: coinCost.original,
        black_sunday_active:
          coinCost.black_sunday_active,
        black_sunday_discount_percent:
          coinCost.black_sunday_discount_percent,
        black_sunday_discount_amount:
          coinCost.black_sunday_discount_amount,
        wallet: publicWallet(payload.wallet),
      })
    }

    const expiresAt = new Date(
      Date.now() +
        accessDays * 24 * 60 * 60 * 1000
    ).toISOString()

    const updatedWallet = await updateGemBalance({
      userId,
      wallet: payload.wallet,
      amount: gemPrice,
    })

    const unlocks = await createUnlocksAndTransactions({
      userId,
      storyId,
      episodes: [payload.episode],
      unlockType: 'gem',
      unlockScope: 'single',
      accessType: 'temporary',
      expiresAt,
      diamondSpent: 0,
      transactionCurrency: 'gem',
      transactionAmount: gemPrice,
      metadata: {
        access_days: accessDays,
        reader_tier: tier,
        original_price: coinCost.original,
        final_price: gemPrice,
        black_sunday_active:
          coinCost.black_sunday_active,
        black_sunday_discount_percent:
          coinCost.black_sunday_discount_percent,
        black_sunday_discount_amount:
          coinCost.black_sunday_discount_amount,
        event_key: coinCost.event?.key || '',
        event_time_zone:
          coinCost.event?.time_zone || '',
        daily_limit_status:
          payload.gemLimits.daily,
        monthly_story_limit_status:
          payload.gemLimits.monthly_story,
      },
    })

    return res.status(200).json({
      ok: true,
      message: 'Episode unlocked with Coins',
      unlocked: true,
      access_type: 'temporary',
      expires_at: expiresAt,
      price: gemPrice,
      original_price: coinCost.original,
      black_sunday_active:
        coinCost.black_sunday_active,
      black_sunday_discount_percent:
        coinCost.black_sunday_discount_percent,
      black_sunday_discount_amount:
        coinCost.black_sunday_discount_amount,
      unlocked_episode_ids: unlocks.map(
        (unlock) => unlock.episode_id
      ),
      wallet: publicWallet(updatedWallet),
    })
  } catch (error) {
    console.error('UNLOCK EPISODE WITH GEMS ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to unlock episode with Coins',
      error: error.message,
    })
  }
}


export async function unlockEpisodeWithVoucher(req, res) {
  try {
    const userId = req.user?.user_id
    const { storyId, episodeId } = req.params
    const tier = getReaderTier(req)

    const payload = await getUnlockStatusPayload({ userId, storyId, episodeId, tier })

    if (payload.notFound) {
      return res.status(404).json({
        ok: false,
        message: 'Episode not found',
      })
    }

    if (payload.freeEpisode || payload.unlocked) {
      return res.status(200).json({
        ok: true,
        message: 'Episode already unlocked',
        unlocked: true,
        wallet: publicWallet(payload.wallet),
      })
    }

    if (!payload.gemWait.available) {
      return res.status(403).json({
        ok: false,
        code: 'VOUCHER_WAIT_REQUIRED',
        message: 'This episode is newly released. Voucher unlock is not available yet.',
        available_at: payload.gemWait.available_at,
        wait_seconds: payload.gemWait.wait_seconds,
        wallet: publicWallet(payload.wallet),
      })
    }

    const voucherPrice = getRuleNumber(
      payload.rules,
      'voucher_cost_per_episode'
    )

    if (Number(payload.wallet.voucher_balance || 0) < voucherPrice) {
      return res.status(402).json({
        ok: false,
        code: 'INSUFFICIENT_VOUCHERS',
        message: 'Not enough Vouchers',
        need:
          voucherPrice -
          Number(
            payload.wallet.voucher_balance || 0
          ),
        price: voucherPrice,
        wallet: publicWallet(payload.wallet),
      })
    }

    const updatedWallet = await updateVoucherBalance({
      userId,
      wallet: payload.wallet,
      amount: voucherPrice,
    })

    const unlocks = await createUnlocksAndTransactions({
      userId,
      storyId,
      episodes: [payload.episode],
      unlockType: 'voucher',
      unlockScope: 'single',
      accessType: 'permanent',
      expiresAt: null,
      diamondSpent: 0,
      transactionCurrency: 'voucher',
      transactionAmount: voucherPrice,
      metadata: {
        reader_tier: tier,
      },
    })

    return res.status(200).json({
      ok: true,
      message: 'Episode unlocked with Voucher',
      unlocked: true,
      access_type: 'permanent',
      unlocked_episode_ids: unlocks.map(
        (unlock) => unlock.episode_id
      ),
      wallet: publicWallet(updatedWallet),
    })
  } catch (error) {
    console.error('UNLOCK EPISODE WITH VOUCHER ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to unlock episode with Voucher',
      error: error.message,
    })
  }
}

export async function unlockEpisodeWithStoryCard(req, res) {
  try {
    const userId = req.user?.user_id
    const { storyId, episodeId } = req.params
    const tier = getReaderTier(req)
    const cardType = normalizeStoryCardType(req.body.card_type || req.body.cardType)

    const payload = await getUnlockStatusPayload({ userId, storyId, episodeId, tier })

    if (payload.notFound) {
      return res.status(404).json({
        ok: false,
        message: 'Episode not found',
      })
    }

    if (payload.freeEpisode || payload.unlocked) {
      return res.status(200).json({
        ok: true,
        message: 'Episode already unlocked',
        unlocked: true,
        wallet: publicWallet(payload.wallet),
      })
    }

    if (!payload.gemWait.available) {
      return res.status(403).json({
        ok: false,
        code: 'STORY_CARD_WAIT_REQUIRED',
        message: 'This episode is newly released. Story Card unlock is not available yet.',
        available_at: payload.gemWait.available_at,
        wait_seconds: payload.gemWait.wait_seconds,
        wallet: publicWallet(payload.wallet),
      })
    }

    const storyCardPrice = getStoryCardCost(payload.rules, cardType)

    if (Number(payload.wallet.story_card_balance || 0) < storyCardPrice) {
      return res.status(402).json({
        ok: false,
        code: 'INSUFFICIENT_STORY_CARDS',
        message: 'Not enough Story Cards',
        need: storyCardPrice - Number(payload.wallet.story_card_balance || 0),
        price: storyCardPrice,
        card_type: cardType,
        wallet: publicWallet(payload.wallet),
      })
    }

    const updatedWallet = await updateStoryCardBalance({
      userId,
      wallet: payload.wallet,
      amount: storyCardPrice,
    })

    const unlocks = await createUnlocksAndTransactions({
      userId,
      storyId,
      episodes: [payload.episode],
      unlockType: 'story_card',
      unlockScope: 'single',
      accessType: 'permanent',
      expiresAt: null,
      diamondSpent: 0,
      transactionCurrency: 'story_card',
      transactionAmount: storyCardPrice,
      metadata: {
        reader_tier: tier,
        card_type: cardType,
      },
    })

    return res.status(200).json({
      ok: true,
      message: 'Episode unlocked with Story Card',
      unlocked: true,
      access_type: 'permanent',
      card_type: cardType,
      unlocked_episode_ids: unlocks.map((unlock) => unlock.episode_id),
      wallet: publicWallet(updatedWallet),
    })
  } catch (error) {
    console.error('UNLOCK EPISODE WITH STORY CARD ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to unlock episode with Story Card',
      error: error.message,
    })
  }
}

export async function unlockEpisodeWithAd(req, res) {
  try {
    const userId = req.user?.user_id
    const { storyId, episodeId } = req.params
    const tier = getReaderTier(req)

    const payload = await getUnlockStatusPayload({ userId, storyId, episodeId, tier })

    if (payload.notFound) {
      return res.status(404).json({
        ok: false,
        message: 'Episode not found',
      })
    }

    if (payload.freeEpisode || payload.unlocked) {
      return res.status(200).json({
        ok: true,
        message: 'Episode already unlocked',
        unlocked: true,
        wallet: publicWallet(payload.wallet),
      })
    }

    if (!payload.gemWait.available) {
      return res.status(403).json({
        ok: false,
        code: 'AD_WAIT_REQUIRED',
        message: 'This episode is newly released. Watch Ad unlock is not available yet.',
        available_at: payload.gemWait.available_at,
        wait_seconds: payload.gemWait.wait_seconds,
        wallet: publicWallet(payload.wallet),
      })
    }

    const accessDays = getRuleNumber(payload.rules, 'gem_access_days')
    const expiresAt = new Date(Date.now() + accessDays * 24 * 60 * 60 * 1000).toISOString()

    const unlocks = await createUnlocksAndTransactions({
      userId,
      storyId,
      episodes: [payload.episode],
      unlockType: 'ad',
      unlockScope: 'single',
      accessType: 'temporary',
      expiresAt,
      diamondSpent: 0,
      transactionCurrency: 'ad',
      transactionAmount: 1,
      metadata: {
        access_days: accessDays,
        reader_tier: tier,
      },
    })

    return res.status(200).json({
      ok: true,
      message: 'Episode unlocked with Ad',
      unlocked: true,
      access_type: 'temporary',
      expires_at: expiresAt,
      unlocked_episode_ids: unlocks.map((unlock) => unlock.episode_id),
      wallet: publicWallet(payload.wallet),
    })
  } catch (error) {
    console.error('UNLOCK EPISODE WITH AD ERROR:', error)

    return res.status(500).json({
      ok: false,
      message: 'Failed to unlock episode with Ad',
      error: error.message,
    })
  }
}
