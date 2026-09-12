import { supabase } from '../config/supabase.js'
import {
  resolveEffectiveAuthorShare,
  splitDistributableRevenue,
} from './revenueRules.service.js'

const CAMBODIA_OFFSET_MS = 7 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

const BOOST_REQUIRED_REQUIREMENTS = {
  total_published_episodes: 100,
  total_words: 100000,
  total_fans: 1000,
  total_net_paid_earnings_usd: 100,
  policy_clear: 1,
}

const BOOST_GROWTH_REQUIREMENTS = {
  total_views: 1000000,
  total_read_hours: 1000,
  total_likes: 1000000,
  total_ratings: 1000,
  total_followers: 1000,
}

function numberValue(value) {
  const number = Number(value || 0)

  if (!Number.isFinite(number)) return 0

  return number
}

function percentValue(value) {
  const number = Number(value || 0)

  if (!Number.isFinite(number)) return 0

  return Math.max(0, Math.min(100, number))
}

function progressPercent(current, required) {
  if (!required || Number(required) <= 0) return 100

  return Math.max(
    0,
    Math.min(
      100,
      Math.floor(
        (numberValue(current) / numberValue(required)) *
          100
      )
    )
  )
}

function buildRequirementProgress(current, required) {
  return {
    current: numberValue(current),
    required: numberValue(required),
    percent: progressPercent(current, required),
    completed:
      numberValue(current) >= numberValue(required),
  }
}

function buildLastStageProgress(totals) {
  const readHours = Math.floor(
    numberValue(totals.total_read_seconds) / 3600
  )

  const requiredRequirements = {
    episodes: buildRequirementProgress(
      totals.total_published_episodes,
      BOOST_REQUIRED_REQUIREMENTS.total_published_episodes
    ),
    words: buildRequirementProgress(
      totals.total_words,
      BOOST_REQUIRED_REQUIREMENTS.total_words
    ),
    fans: buildRequirementProgress(
      totals.total_fans,
      BOOST_REQUIRED_REQUIREMENTS.total_fans
    ),
    paid_earnings: buildRequirementProgress(
      totals.total_net_paid_earnings_usd,
      BOOST_REQUIRED_REQUIREMENTS.total_net_paid_earnings_usd
    ),
    policy: buildRequirementProgress(
      totals.has_serious_policy_violation ? 0 : 1,
      BOOST_REQUIRED_REQUIREMENTS.policy_clear
    ),
  }

  const growthRequirements = {
    views: buildRequirementProgress(
      totals.total_views,
      BOOST_GROWTH_REQUIREMENTS.total_views
    ),
    read_hours: buildRequirementProgress(
      readHours,
      BOOST_GROWTH_REQUIREMENTS.total_read_hours
    ),
    likes: buildRequirementProgress(
      totals.total_likes,
      BOOST_GROWTH_REQUIREMENTS.total_likes
    ),
    ratings: buildRequirementProgress(
      totals.total_ratings,
      BOOST_GROWTH_REQUIREMENTS.total_ratings
    ),
    followers: buildRequirementProgress(
      totals.total_followers,
      BOOST_GROWTH_REQUIREMENTS.total_followers
    ),
  }

  const requiredCompleted =
    Object.values(requiredRequirements).every(
      (item) => item.completed
    )

  const growthCompletedCount =
    Object.values(growthRequirements).filter(
      (item) => item.completed
    ).length

  return {
    title: '100-Day Creator Boost',
    share_percent: 100,
    duration_days: 100,
    once_per_account: true,
    completed:
      requiredCompleted &&
      growthCompletedCount >= 3,
    required_completed: requiredCompleted,
    growth_completed_count: growthCompletedCount,
    growth_required_count: 3,
    requirements: {
      ...requiredRequirements,
      ...growthRequirements,
    },
    required_requirements: requiredRequirements,
    growth_requirements: growthRequirements,
  }
}

function validDate(value, fallback = new Date()) {
  const date = value instanceof Date
    ? value
    : new Date(value)

  if (Number.isNaN(date.getTime())) {
    return fallback
  }

  return date
}

function getMonthKey(date = new Date()) {
  const cambodiaDate = new Date(
    validDate(date).getTime() + CAMBODIA_OFFSET_MS
  )
  const year = cambodiaDate.getUTCFullYear()
  const month = String(
    cambodiaDate.getUTCMonth() + 1
  ).padStart(2, '0')

  return `${year}-${month}`
}

function addDaysIso(days, fromDate = new Date()) {
  const safeDays = Math.max(0, numberValue(days))
  const start = validDate(fromDate)

  return new Date(
    start.getTime() + safeDays * DAY_MS
  ).toISOString()
}

function metadataValue(metadata) {
  if (!metadata) return {}

  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata)

      return parsed && typeof parsed === 'object'
        ? parsed
        : {}
    } catch {
      return {}
    }
  }

  return typeof metadata === 'object'
    ? metadata
    : {}
}

function isStageCompleted(stage, totals) {
  return (
    numberValue(totals.total_published_episodes) >=
      numberValue(stage.required_episodes) &&
    numberValue(totals.total_words) >=
      numberValue(stage.required_words) &&
    numberValue(totals.total_likes) >=
      numberValue(stage.required_likes) &&
    numberValue(totals.total_followers) >=
      numberValue(stage.required_followers)
  )
}

function getBestStage(stages, totals) {
  const activeStages = (stages || [])
    .filter((stage) => stage.is_active !== false)
    .sort(
      (a, b) =>
        numberValue(a.stage_number) -
        numberValue(b.stage_number)
    )

  let bestStage = activeStages[0] || null

  for (const stage of activeStages) {
    if (isStageCompleted(stage, totals)) {
      bestStage = stage
    }
  }

  return bestStage
}

async function getRevenueSettings() {
  const { data, error } = await supabase
    .from('author_revenue_settings')
    .select('*')
    .eq('id', 1)
    .maybeSingle()

  if (error) throw error

  return data || {
    diamond_to_usd_rate: 0.01,
    default_share_percent: 10,
    payout_pending_days: 0,
    withholding_enabled: false,
    withholding_percent: 0,
  }
}

async function getQuestStages() {
  const { data, error } = await supabase
    .from('author_quest_stages')
    .select('*')
    .eq('is_active', true)
    .order('stage_number', { ascending: true })

  if (error) throw error

  return data || []
}

async function getPaidFanCount(authorId) {
  const { data, error } = await supabase
    .from('episode_unlock_transactions')
    .select('user_id, episode_id')
    .eq('author_id', authorId)
    .eq('currency', 'diamond')
    .eq('transaction_type', 'unlock')
    .gt('amount', 0)

  if (error) throw error

  const readers = new Map()

  for (const row of data || []) {
    const readerId = String(row.user_id || '')
    const episodeId = String(row.episode_id || '')

    if (!readerId || !episodeId) continue

    if (!readers.has(readerId)) {
      readers.set(readerId, new Set())
    }

    readers.get(readerId).add(episodeId)
  }

  return [...readers.values()].filter(
    (episodes) => episodes.size >= 10
  ).length
}

async function getTotalNetPaidEarnings(authorId) {
  const { data, error } = await supabase
    .from('author_earnings')
    .select('author_net_payout_usd')
    .eq('author_id', authorId)
    .eq('currency', 'diamond')
    .eq('source_type', 'diamond_unlock')
    .neq('earning_status', 'void')

  if (error) throw error

  return (data || []).reduce(
    (total, row) =>
      total +
      numberValue(row.author_net_payout_usd),
    0
  )
}

async function getActiveLifetimeBoost(authorId) {
  const { data, error } = await supabase
    .from('author_lifetime_boosts')
    .select('*')
    .eq('author_id', authorId)
    .eq('boost_type', '100_percent_100_days')
    .eq('status', 'active')
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  if (
    data.ended_at &&
    new Date(data.ended_at).getTime() <= Date.now()
  ) {
    const nowIso = new Date().toISOString()
    const { data: updatedBoost, error: updateError } =
      await supabase
        .from('author_lifetime_boosts')
        .update({
          status: 'expired',
          used_at: data.used_at || nowIso,
          updated_at: nowIso,
        })
        .eq('id', data.id)
        .select()
        .single()

    if (updateError) throw updateError

    return updatedBoost
  }

  return data
}

async function getOrCreateLifetimeBoost({
  authorPage,
  lastStage,
}) {
  const { data: oldBoost, error: oldError } =
    await supabase
      .from('author_lifetime_boosts')
      .select('*')
      .eq('author_id', authorPage.id)
      .eq('boost_type', '100_percent_100_days')
      .maybeSingle()

  if (oldError) throw oldError

  const shouldActivate = Boolean(
    lastStage?.completed
  )
  const now = new Date()
  const nowIso = now.toISOString()

  if (oldBoost) {
    if (
      shouldActivate &&
      ['locked', 'eligible'].includes(
        String(oldBoost.status || '').toLowerCase()
      )
    ) {
      const eligibleAt = oldBoost.eligible_at
        ? new Date(oldBoost.eligible_at)
        : now
      const startedAt = Number.isNaN(
        eligibleAt.getTime()
      )
        ? now
        : eligibleAt
      const endedAt = new Date(
        startedAt.getTime() +
          100 * DAY_MS
      )
      const status =
        endedAt.getTime() <= now.getTime()
          ? 'expired'
          : 'active'

      const {
        data: updatedBoost,
        error: updateError,
      } = await supabase
        .from('author_lifetime_boosts')
        .update({
          status,
          share_percent: 100,
          duration_days: 100,
          eligible_at:
            oldBoost.eligible_at ||
            startedAt.toISOString(),
          started_at: startedAt.toISOString(),
          ended_at: endedAt.toISOString(),
          used_at:
            oldBoost.used_at ||
            startedAt.toISOString(),
          updated_at: nowIso,
        })
        .eq('id', oldBoost.id)
        .in('status', ['locked', 'eligible'])
        .select()
        .maybeSingle()

      if (updateError) throw updateError

      return updatedBoost || oldBoost
    }

    return oldBoost
  }

  if (shouldActivate) {
    const endedAt = new Date(
      now.getTime() + 100 * DAY_MS
    )

    const { data, error } = await supabase
      .from('author_lifetime_boosts')
      .insert({
        author_id: authorPage.id,
        user_id: authorPage.user_id,
        boost_type: '100_percent_100_days',
        share_percent: 100,
        duration_days: 100,
        status: 'active',
        eligible_at: nowIso,
        started_at: nowIso,
        ended_at: endedAt.toISOString(),
        used_at: nowIso,
      })
      .select()
      .single()

    if (error) throw error

    return data
  }

  const { data, error } = await supabase
    .from('author_lifetime_boosts')
    .insert({
      author_id: authorPage.id,
      user_id: authorPage.user_id,
      boost_type: '100_percent_100_days',
      share_percent: 100,
      duration_days: 100,
      status: 'locked',
      eligible_at: null,
    })
    .select()
    .single()

  if (error) throw error

  return data
}

async function getActive49DayEvent(authorId) {
  const { data, error } = await supabase
    .from('author_49_day_event_progress')
    .select('*')
    .eq('author_id', authorId)
    .eq('status', 'active')
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const endsAt = new Date(data.ends_at).getTime()

  if (
    Number.isFinite(endsAt) &&
    endsAt > Date.now()
  ) {
    return data
  }

  const nowIso = new Date().toISOString()
  const { error: updateError } = await supabase
    .from('author_49_day_event_progress')
    .update({
      status: 'finished',
      ended_at: nowIso,
      end_reason: '49_days_completed',
      updated_at: nowIso,
    })
    .eq('author_id', authorId)
    .eq('status', 'active')

  if (updateError) throw updateError

  return null
}

async function finish49DayEventForCreatorBoost(
  authorId
) {
  const nowIso = new Date().toISOString()

  const { error } = await supabase
    .from('author_49_day_event_progress')
    .update({
      status: 'finished',
      ended_at: nowIso,
      end_reason: '100_day_creator_boost',
      updated_at: nowIso,
    })
    .eq('author_id', authorId)
    .eq('status', 'active')

  if (error) throw error
}

async function getAuthorTotals(authorPage) {
  const { data: stories, error: storiesError } =
    await supabase
      .from('stories')
      .select(
        'id, total_likes, total_views, total_comments'
      )
      .eq('author_id', authorPage.id)

  if (storiesError) throw storiesError

  const storyIds = (stories || []).map(
    (story) => story.id
  )
  let episodes = []

  if (storyIds.length) {
    const {
      data: episodeRows,
      error: episodesError,
    } = await supabase
      .from('episodes')
      .select(
        'id, story_id, character_count, word_count, total_likes, status'
      )
      .in('story_id', storyIds)

    if (episodesError) throw episodesError

    episodes = episodeRows || []
  }

  const publishedEpisodes = episodes.filter(
    (episode) => episode.status === 'published'
  )

  const [
    totalPaidFans,
    totalNetPaidEarningsUsd,
  ] = await Promise.all([
    getPaidFanCount(authorPage.id),
    getTotalNetPaidEarnings(authorPage.id),
  ])

  return {
    total_published_episodes:
      publishedEpisodes.length,
    total_words: publishedEpisodes.reduce(
      (sum, episode) =>
        sum +
        numberValue(
          episode.word_count ||
            episode.character_count
        ),
      0
    ),
    total_likes: publishedEpisodes.reduce(
      (sum, episode) =>
        sum + numberValue(episode.total_likes),
      0
    ),
    total_followers: numberValue(
      authorPage.total_followers
    ),
    total_views: (stories || []).reduce(
      (sum, story) =>
        sum + numberValue(story.total_views),
      0
    ),
    total_comments: (stories || []).reduce(
      (sum, story) =>
        sum + numberValue(story.total_comments),
      0
    ),
    total_ratings: 0,
    total_read_seconds: 0,
    total_paid_fans: totalPaidFans,
    total_fans: totalPaidFans,
    total_net_paid_earnings_usd:
      totalNetPaidEarningsUsd,
    has_serious_policy_violation: Boolean(
      authorPage.has_serious_policy_violation
    ),
  }
}

async function upsertQuestProgress({
  authorPage,
  bestStage,
  totals,
}) {
  const nowIso = new Date().toISOString()
  const payload = {
    author_id: authorPage.id,
    user_id: authorPage.user_id,
    current_stage_number: numberValue(
      bestStage?.stage_number || 1
    ),
    current_share_percent: percentValue(
      bestStage?.share_percent || 10
    ),
    total_published_episodes: numberValue(
      totals.total_published_episodes
    ),
    total_words: numberValue(totals.total_words),
    total_likes: numberValue(totals.total_likes),
    total_followers: numberValue(
      totals.total_followers
    ),
    total_views: numberValue(totals.total_views),
    total_comments: numberValue(
      totals.total_comments
    ),
    total_ratings: numberValue(
      totals.total_ratings
    ),
    total_read_seconds: numberValue(
      totals.total_read_seconds
    ),
    last_calculated_at: nowIso,
    updated_at: nowIso,
  }

  const { data, error } = await supabase
    .from('author_quest_progress')
    .upsert(payload, {
      onConflict: 'author_id',
    })
    .select()
    .single()

  if (error) throw error

  return data
}

async function getAuthorShareContext(
  authorPage,
  settings
) {
  const [
    active49DayEvent,
    stages,
    totals,
  ] = await Promise.all([
    getActive49DayEvent(authorPage.id),
    getQuestStages(),
    getAuthorTotals(authorPage),
  ])

  const bestStage = getBestStage(stages, totals)
  const progress = await upsertQuestProgress({
    authorPage,
    bestStage,
    totals,
  })
  const lastStage = buildLastStageProgress(totals)
  const lifetimeBoost =
    await getOrCreateLifetimeBoost({
      authorPage,
      lastStage,
    })
  const activeBoost =
    lifetimeBoost?.status === 'active'
      ? lifetimeBoost
      : await getActiveLifetimeBoost(
          authorPage.id
        )

  let current49DayEvent = active49DayEvent

  if (
    activeBoost?.status === 'active' &&
    active49DayEvent?.status === 'active'
  ) {
    await finish49DayEventForCreatorBoost(
      authorPage.id
    )
    current49DayEvent = null
  }

  const questSharePercent = percentValue(
    progress.current_share_percent ||
      settings.default_share_percent ||
      10
  )

  const boostSharePercent =
    activeBoost?.status === 'active'
      ? percentValue(activeBoost.share_percent)
      : 0

  const eventSharePercent =
    current49DayEvent?.status === 'active'
      ? percentValue(
          current49DayEvent.share_percent
        )
      : 0

  return {
    quest_share_percent: questSharePercent,
    event_share_percent: eventSharePercent,
    boost_share_percent: boostSharePercent,
    quest_stage_number: numberValue(
      progress.current_stage_number || 1
    ),
    lifetime_boost_id:
      activeBoost?.status === 'active'
        ? activeBoost.id
        : null,
  }
}

async function getExistingEarningTransactionIds(
  transactionIds
) {
  if (!transactionIds.length) return new Set()

  const { data, error } = await supabase
    .from('author_earnings')
    .select('unlock_transaction_id')
    .in('unlock_transaction_id', transactionIds)

  if (error) throw error

  return new Set(
    (data || []).map(
      (item) => item.unlock_transaction_id
    )
  )
}

function getPerEpisodeOriginalDiamonds(
  transaction,
  metadata
) {
  const episodeCount = Math.max(
    1,
    numberValue(metadata.episode_count || 1)
  )
  const originalPrice = numberValue(
    metadata.original_price
  )

  if (originalPrice > 0) {
    return originalPrice / episodeCount
  }

  const discountPercent = percentValue(
    metadata.total_discount_percent ??
      metadata.discount_percent
  )

  if (
    discountPercent > 0 &&
    discountPercent < 100
  ) {
    return (
      numberValue(transaction.amount) /
      ((100 - discountPercent) / 100)
    )
  }

  return numberValue(transaction.amount)
}

function getPerEpisodeDirectCostDiamonds(
  transaction,
  metadata
) {
  const paidDiamonds = numberValue(
    transaction.amount
  )
  const perEpisodeCost = numberValue(
    metadata.direct_cost_per_episode_diamonds
  )

  if (perEpisodeCost > 0) {
    return Math.min(
      paidDiamonds,
      perEpisodeCost
    )
  }

  const packageCost = numberValue(
    metadata.package_direct_cost_diamonds
  )
  const episodeCount = Math.max(
    1,
    numberValue(metadata.episode_count || 1)
  )

  if (packageCost > 0) {
    return Math.min(
      paidDiamonds,
      packageCost / episodeCount
    )
  }

  return Math.min(
    paidDiamonds,
    Math.max(
      0,
      numberValue(metadata.direct_cost_diamonds)
    )
  )
}

export async function createAuthorEarningsFromDiamondUnlock({
  transactions = [],
}) {
  const diamondTransactions = (transactions || [])
    .filter((transaction) => transaction?.id)
    .filter(
      (transaction) =>
        transaction.currency === 'diamond'
    )
    .filter(
      (transaction) =>
        transaction.transaction_type === 'unlock'
    )
    .filter(
      (transaction) =>
        numberValue(transaction.amount) > 0
    )
    .filter(
      (transaction) => transaction.author_id
    )

  if (!diamondTransactions.length) return []

  const transactionIds = diamondTransactions.map(
    (transaction) => transaction.id
  )
  const existingIds =
    await getExistingEarningTransactionIds(
      transactionIds
    )
  const newTransactions =
    diamondTransactions.filter(
      (transaction) =>
        !existingIds.has(transaction.id)
    )

  if (!newTransactions.length) return []

  const authorIds = [
    ...new Set(
      newTransactions.map(
        (transaction) => transaction.author_id
      )
    ),
  ]
  const { data: authors, error: authorError } =
    await supabase
      .from('author_pages')
      .select(
        'id, user_id, total_followers, has_serious_policy_violation'
      )
      .in('id', authorIds)

  if (authorError) throw authorError

  const authorMap = new Map(
    (authors || []).map((author) => [
      author.id,
      author,
    ])
  )
  const settings = await getRevenueSettings()
  const shareContextMap = new Map()
  const rows = []
  const batchDate = new Date()

  for (const transaction of newTransactions) {
    const authorPage = authorMap.get(
      transaction.author_id
    )

    if (!authorPage) continue

    if (!shareContextMap.has(authorPage.id)) {
      shareContextMap.set(
        authorPage.id,
        await getAuthorShareContext(
          authorPage,
          settings
        )
      )
    }

    const shareContext = shareContextMap.get(
      authorPage.id
    )
    const metadata = metadataValue(
      transaction.metadata
    )
    const transactionDate = validDate(
      transaction.created_at,
      batchDate
    )
    const netPaidDiamonds = numberValue(
      transaction.amount
    )
    const originalDiamonds =
      getPerEpisodeOriginalDiamonds(
        transaction,
        metadata
      )
    const eventSharePercent = Math.max(
      percentValue(
        metadata.event_author_share_percent
      ),
      percentValue(
        metadata.promotion_author_share_percent
      ),
      percentValue(
        metadata.writer_wednesday_author_share_percent
      ),
      percentValue(
        shareContext.event_share_percent
      )
    )
    const shareDecision =
      resolveEffectiveAuthorShare({
        questSharePercent:
          shareContext.quest_share_percent,
        eventSharePercent,
        boostSharePercent:
          shareContext.boost_share_percent,
      })

    const directCostDiamonds =
      getPerEpisodeDirectCostDiamonds(
        transaction,
        metadata
      )
    const distributableNetRevenue = Math.max(
      0,
      netPaidDiamonds - directCostDiamonds
    )
    const revenueSplit =
      splitDistributableRevenue({
        distributableNetRevenue,
        authorSharePercent:
          shareDecision.effective_author_share_percent,
      })
    const authorSharePercent =
      shareDecision.effective_author_share_percent
    const authorEarnedDiamonds =
      revenueSplit.author_revenue
    const platformEarnedDiamonds =
      revenueSplit.platform_revenue
    const diamondToUsdRate = numberValue(
      settings.diamond_to_usd_rate
    )
    const authorGrossUsd =
      authorEarnedDiamonds * diamondToUsdRate
    const withholdingEnabled = Boolean(
      settings.withholding_enabled
    )
    const withholdingPercent =
      withholdingEnabled
        ? percentValue(
            settings.withholding_percent
          )
        : 0
    const withholdingAmountUsd =
      authorGrossUsd *
      (withholdingPercent / 100)
    const authorNetPayoutUsd = Math.max(
      0,
      authorGrossUsd - withholdingAmountUsd
    )
    const payoutPendingDays = Math.max(
      0,
      numberValue(
        settings.payout_pending_days
      )
    )
    const nowIso = new Date().toISOString()

    rows.push({
      author_id: authorPage.id,
      author_user_id: authorPage.user_id,
      reader_id: transaction.user_id,
      story_id: transaction.story_id,
      episode_id: transaction.episode_id,
      unlock_transaction_id: transaction.id,
      source_type: 'diamond_unlock',
      currency: 'diamond',
      paid_diamonds: netPaidDiamonds,
      original_diamonds: originalDiamonds,
      discount_percent: percentValue(
        metadata.total_discount_percent ??
          metadata.discount_percent
      ),
      net_paid_diamonds:
        revenueSplit.distributable_net_revenue,
      author_share_percent:
        authorSharePercent,
      share_source:
        shareDecision.effective_share_source,
      quest_stage_number:
        shareContext.quest_stage_number,
      lifetime_boost_id:
        shareContext.lifetime_boost_id,
      author_earned_diamonds:
        authorEarnedDiamonds,
      platform_earned_diamonds:
        platformEarnedDiamonds,
      diamond_to_usd_rate:
        diamondToUsdRate,
      author_gross_usd: authorGrossUsd,
      withholding_enabled:
        withholdingEnabled,
      withholding_percent:
        withholdingPercent,
      withholding_amount_usd:
        withholdingAmountUsd,
      author_net_payout_usd:
        authorNetPayoutUsd,
      earning_status:
        payoutPendingDays > 0
          ? 'pending'
          : 'available',
      earning_month:
        getMonthKey(transactionDate),
      available_at: addDaysIso(
        payoutPendingDays,
        transactionDate
      ),
      metadata: {
        ...metadata,
        direct_cost_diamonds:
          directCostDiamonds,
        distributable_net_revenue_diamonds:
          revenueSplit.distributable_net_revenue,
        quest_share_percent:
          shareDecision.quest_share_percent,
        event_share_percent:
          shareDecision.event_share_percent,
        boost_share_percent:
          shareDecision.boost_share_percent,
        effective_author_share_percent:
          authorSharePercent,
        effective_share_source:
          shareDecision.effective_share_source,
        revenue_rules_version: '2026-08-02',
      },
      updated_at: nowIso,
    })
  }

  if (!rows.length) return []

  const { data, error } = await supabase
    .from('author_earnings')
    .insert(rows)
    .select()

  if (error) throw error

  return data || []
}
