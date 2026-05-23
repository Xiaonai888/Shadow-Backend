import { supabase } from '../config/supabase.js'

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

function getMonthKey(date = new Date()) {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')

  return `${year}-${month}`
}

function addDaysIso(days) {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + numberValue(days))

  return date.toISOString()
}

function isStageCompleted(stage, totals) {
  return (
    numberValue(totals.total_published_episodes) >= numberValue(stage.required_episodes) &&
    numberValue(totals.total_words) >= numberValue(stage.required_words) &&
    numberValue(totals.total_likes) >= numberValue(stage.required_likes) &&
    numberValue(totals.total_followers) >= numberValue(stage.required_followers)
  )
}

function getBestStage(stages, totals) {
  const activeStages = (stages || [])
    .filter((stage) => stage.is_active !== false)
    .sort((a, b) => numberValue(a.stage_number) - numberValue(b.stage_number))

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

  if (data.ended_at && new Date(data.ended_at).getTime() <= Date.now()) {
    const { data: updatedBoost, error: updateError } = await supabase
      .from('author_lifetime_boosts')
      .update({
        status: 'expired',
        used_at: data.used_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', data.id)
      .select()
      .single()

    if (updateError) throw updateError

    return updatedBoost
  }

  return data
}

async function getAuthorTotals(authorPage) {
  const { data: stories, error: storiesError } = await supabase
    .from('stories')
    .select('id, total_likes, total_views, total_comments')
    .eq('author_id', authorPage.id)

  if (storiesError) throw storiesError

  const storyIds = (stories || []).map((story) => story.id)
  let episodes = []

  if (storyIds.length) {
    const { data: episodeRows, error: episodesError } = await supabase
      .from('episodes')
      .select('id, story_id, character_count, word_count, total_likes, status')
      .in('story_id', storyIds)

    if (episodesError) throw episodesError

    episodes = episodeRows || []
  }

  const publishedEpisodes = episodes.filter((episode) => episode.status === 'published')

  return {
    total_published_episodes: publishedEpisodes.length,
    total_words: publishedEpisodes.reduce(
  (sum, episode) => sum + numberValue(episode.word_count || episode.character_count),
  0,
),
    total_likes: publishedEpisodes.reduce(
  (sum, episode) => sum + numberValue(episode.total_likes),
  0,
),
    total_followers: numberValue(authorPage.total_followers),
    total_views: (stories || []).reduce((sum, story) => sum + numberValue(story.total_views), 0),
    total_comments: (stories || []).reduce((sum, story) => sum + numberValue(story.total_comments), 0),
    total_ratings: 0,
    total_read_seconds: 0,
  }
}

async function upsertQuestProgress({ authorPage, bestStage, totals }) {
  const payload = {
    author_id: authorPage.id,
    user_id: authorPage.user_id,
    current_stage_number: numberValue(bestStage?.stage_number || 1),
    current_share_percent: percentValue(bestStage?.share_percent || 10),
    total_published_episodes: numberValue(totals.total_published_episodes),
    total_words: numberValue(totals.total_words),
    total_likes: numberValue(totals.total_likes),
    total_followers: numberValue(totals.total_followers),
    total_views: numberValue(totals.total_views),
    total_comments: numberValue(totals.total_comments),
    total_ratings: numberValue(totals.total_ratings),
    total_read_seconds: numberValue(totals.total_read_seconds),
    last_calculated_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
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

async function getAuthorShareContext(authorPage, settings) {
  const activeBoost = await getActiveLifetimeBoost(authorPage.id)

  if (activeBoost?.status === 'active') {
    return {
      share_percent: percentValue(activeBoost.share_percent),
      share_source: 'lifetime_boost',
      quest_stage_number: null,
      lifetime_boost_id: activeBoost.id,
    }
  }

  const [stages, totals] = await Promise.all([
    getQuestStages(),
    getAuthorTotals(authorPage),
  ])

  const bestStage = getBestStage(stages, totals)
  const progress = await upsertQuestProgress({
    authorPage,
    bestStage,
    totals,
  })

  return {
    share_percent: percentValue(progress.current_share_percent || settings.default_share_percent || 10),
    share_source: 'quest_stage',
    quest_stage_number: numberValue(progress.current_stage_number || 1),
    lifetime_boost_id: null,
  }
}

async function getExistingEarningTransactionIds(transactionIds) {
  if (!transactionIds.length) return new Set()

  const { data, error } = await supabase
    .from('author_earnings')
    .select('unlock_transaction_id')
    .in('unlock_transaction_id', transactionIds)

  if (error) throw error

  return new Set((data || []).map((item) => item.unlock_transaction_id))
}

function getPerEpisodeOriginalDiamonds(transaction, metadata) {
  const episodeCount = numberValue(metadata?.episode_count || 1)
  const originalPrice = numberValue(metadata?.original_price)

  if (episodeCount > 0 && originalPrice > 0) {
    return originalPrice / episodeCount
  }

  const discountPercent = percentValue(metadata?.discount_percent)

  if (discountPercent > 0 && discountPercent < 100) {
    return numberValue(transaction.amount) / ((100 - discountPercent) / 100)
  }

  return numberValue(transaction.amount)
}

export async function createAuthorEarningsFromDiamondUnlock({ transactions = [] }) {
  const diamondTransactions = (transactions || [])
    .filter((transaction) => transaction?.id)
    .filter((transaction) => transaction.currency === 'diamond')
    .filter((transaction) => numberValue(transaction.amount) > 0)
    .filter((transaction) => transaction.author_id)

  if (!diamondTransactions.length) return []

  const transactionIds = diamondTransactions.map((transaction) => transaction.id)
  const existingIds = await getExistingEarningTransactionIds(transactionIds)
  const newTransactions = diamondTransactions.filter((transaction) => !existingIds.has(transaction.id))

  if (!newTransactions.length) return []

  const authorIds = [...new Set(newTransactions.map((transaction) => transaction.author_id))]
  const { data: authors, error: authorError } = await supabase
    .from('author_pages')
    .select('id, user_id, total_followers')
    .in('id', authorIds)

  if (authorError) throw authorError

  const authorMap = new Map((authors || []).map((author) => [author.id, author]))
  const settings = await getRevenueSettings()
  const shareContextMap = new Map()
  const rows = []

  for (const transaction of newTransactions) {
    const authorPage = authorMap.get(transaction.author_id)

    if (!authorPage) continue

    if (!shareContextMap.has(authorPage.id)) {
      shareContextMap.set(authorPage.id, await getAuthorShareContext(authorPage, settings))
    }

    const shareContext = shareContextMap.get(authorPage.id)
    const metadata = transaction.metadata || {}
    const netPaidDiamonds = numberValue(transaction.amount)
    const originalDiamonds = getPerEpisodeOriginalDiamonds(transaction, metadata)
    const authorEarnedDiamonds = netPaidDiamonds * (shareContext.share_percent / 100)
    const platformEarnedDiamonds = Math.max(0, netPaidDiamonds - authorEarnedDiamonds)
    const authorGrossUsd = authorEarnedDiamonds * numberValue(settings.diamond_to_usd_rate)
    const withholdingEnabled = Boolean(settings.withholding_enabled)
    const withholdingPercent = withholdingEnabled ? percentValue(settings.withholding_percent) : 0
    const withholdingAmountUsd = authorGrossUsd * (withholdingPercent / 100)
    const authorNetPayoutUsd = Math.max(0, authorGrossUsd - withholdingAmountUsd)

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
      discount_percent: percentValue(metadata.discount_percent),
      net_paid_diamonds: netPaidDiamonds,
      author_share_percent: shareContext.share_percent,
      share_source: shareContext.share_source,
      quest_stage_number: shareContext.quest_stage_number,
      lifetime_boost_id: shareContext.lifetime_boost_id,
      author_earned_diamonds: authorEarnedDiamonds,
      platform_earned_diamonds: platformEarnedDiamonds,
      diamond_to_usd_rate: numberValue(settings.diamond_to_usd_rate),
      author_gross_usd: authorGrossUsd,
      withholding_enabled: withholdingEnabled,
      withholding_percent: withholdingPercent,
      withholding_amount_usd: withholdingAmountUsd,
      author_net_payout_usd: authorNetPayoutUsd,
      earning_status: numberValue(settings.payout_pending_days) > 0 ? 'pending' : 'available',
      earning_month: getMonthKey(),
      available_at: addDaysIso(settings.payout_pending_days),
      metadata,
      updated_at: new Date().toISOString(),
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
