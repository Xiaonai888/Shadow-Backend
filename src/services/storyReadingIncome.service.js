import { supabase } from '../config/supabase.js'

const DEFAULT_DIAMOND_TO_USD_RATE = 0.01
const REVENUE_TOLERANCE = 0.000001

function numberValue(value) {
  const number = Number(value)

  return Number.isFinite(number) ? number : 0
}

function hasNumber(value) {
  return value !== null &&
    value !== undefined &&
    value !== '' &&
    Number.isFinite(Number(value))
}

function nonNegativeInteger(value) {
  return Math.max(
    0,
    Math.floor(numberValue(value))
  )
}

function nonNegativeNumber(value) {
  return Math.max(0, numberValue(value))
}

function percentValue(value) {
  return Math.max(
    0,
    Math.min(100, numberValue(value))
  )
}

function roundValue(value) {
  return Math.round(
    (numberValue(value) + Number.EPSILON) *
      1000000
  ) / 1000000
}

async function getDiamondToUsdRate() {
  const { data, error } = await supabase
    .from('author_revenue_settings')
    .select('diamond_to_usd_rate')
    .eq('id', 1)
    .maybeSingle()

  if (error) {
    console.error(
      'GET STORY READING DIAMOND RATE ERROR:',
      error
    )
    return DEFAULT_DIAMOND_TO_USD_RATE
  }

  const rate = numberValue(
    data?.diamond_to_usd_rate
  )

  return rate > 0
    ? rate
    : DEFAULT_DIAMOND_TO_USD_RATE
}

function validateRevenueDecision({
  paidDiamonds,
  directCostDiamonds,
  distributableNetRevenueDiamonds,
  authorSharePercent,
  authorEarnedDiamonds,
  platformEarnedDiamonds,
  shareSource,
}) {
  if (!hasNumber(authorSharePercent)) {
    throw new Error(
      'Missing authoritative author share percent'
    )
  }

  const cleanShareSource = String(
    shareSource || ''
  ).trim()

  if (!cleanShareSource) {
    throw new Error(
      'Missing authoritative share source'
    )
  }

  const paid = nonNegativeNumber(
    paidDiamonds
  )
  const directCost = Math.min(
    paid,
    nonNegativeNumber(directCostDiamonds)
  )
  const expectedNet = roundValue(
    Math.max(0, paid - directCost)
  )
  const suppliedNet = hasNumber(
    distributableNetRevenueDiamonds
  )
    ? roundValue(
        nonNegativeNumber(
          distributableNetRevenueDiamonds
        )
      )
    : expectedNet

  if (
    Math.abs(suppliedNet - expectedNet) >
    REVENUE_TOLERANCE
  ) {
    throw new Error(
      'Distributable revenue does not match paid amount minus direct cost'
    )
  }

  const authorRevenue = roundValue(
    nonNegativeNumber(
      authorEarnedDiamonds
    )
  )
  const platformRevenue = roundValue(
    nonNegativeNumber(
      platformEarnedDiamonds
    )
  )

  if (
    Math.abs(
      suppliedNet -
        authorRevenue -
        platformRevenue
    ) > REVENUE_TOLERANCE
  ) {
    throw new Error(
      'Author and platform revenue do not balance with distributable revenue'
    )
  }

  const authorShare = percentValue(
    authorSharePercent
  )

  return {
    paid_diamonds: paid,
    direct_cost_diamonds: directCost,
    distributable_net_revenue_diamonds:
      suppliedNet,
    author_share_percent: authorShare,
    platform_share_percent:
      roundValue(100 - authorShare),
    author_earned_diamonds:
      authorRevenue,
    platform_earned_diamonds:
      platformRevenue,
    share_source: cleanShareSource,
  }
}

export async function createStoryReadingIncome({
  purchaseKey,
  readerId,
  storyId,
  authorId = null,
  firstEpisodeId = null,
  packageKey = 'single',
  episodeCount = 1,
  originalDiamonds = 0,
  packageDiscountPercent = 0,
  blackSundayDiscountPercent = 0,
  paidDiamonds = 0,
  authorSharePercent = null,
  shareSource = '',
  authorEarnedDiamonds = 0,
  platformEarnedDiamonds = 0,
  directCostDiamonds = 0,
  distributableNetRevenueDiamonds = null,
  metadata = {},
}) {
  const cleanPurchaseKey = String(
    purchaseKey || ''
  ).trim()
  const cleanReaderId = String(
    readerId || ''
  ).trim()
  const cleanStoryId = String(
    storyId || ''
  ).trim()
  const finalPaidDiamonds =
    nonNegativeInteger(paidDiamonds)

  if (
    !cleanPurchaseKey ||
    !cleanReaderId ||
    !cleanStoryId ||
    finalPaidDiamonds <= 0
  ) {
    return null
  }

  const revenue = validateRevenueDecision({
    paidDiamonds: finalPaidDiamonds,
    directCostDiamonds,
    distributableNetRevenueDiamonds,
    authorSharePercent,
    authorEarnedDiamonds,
    platformEarnedDiamonds,
    shareSource,
  })

  const diamondToUsdRate =
    await getDiamondToUsdRate()
  const cleanMetadata =
    metadata &&
    typeof metadata === 'object'
      ? metadata
      : {}

  const payload = {
    purchase_key: cleanPurchaseKey,
    reader_id: cleanReaderId,
    story_id: cleanStoryId,
    author_id: authorId || null,
    first_episode_id:
      firstEpisodeId || null,
    package_key:
      String(packageKey || 'single').trim() ||
      'single',
    episode_count: Math.max(
      1,
      nonNegativeInteger(episodeCount)
    ),
    currency: 'diamond',
    original_diamonds:
      nonNegativeInteger(originalDiamonds),
    package_discount_percent:
      percentValue(packageDiscountPercent),
    black_sunday_discount_percent:
      percentValue(
        blackSundayDiscountPercent
      ),
    paid_diamonds: finalPaidDiamonds,
    diamond_to_usd_rate:
      diamondToUsdRate,
    platform_share_percent:
      revenue.platform_share_percent,
    author_share_percent:
      revenue.author_share_percent,
    income_status: 'completed',
    metadata: {
      ...cleanMetadata,
      revenue_source: 'author_earnings',
      share_source:
        revenue.share_source,
      author_earned_diamonds:
        revenue.author_earned_diamonds,
      platform_earned_diamonds:
        revenue.platform_earned_diamonds,
      direct_cost_diamonds:
        revenue.direct_cost_diamonds,
      distributable_net_revenue_diamonds:
        revenue.distributable_net_revenue_diamonds,
    },
    updated_at: new Date().toISOString(),
  }

  const { data, error } = await supabase
    .from(
      'story_reading_income_transactions'
    )
    .upsert(payload, {
      onConflict: 'purchase_key',
      ignoreDuplicates: true,
    })
    .select()
    .maybeSingle()

  if (error) throw error

  return data || null
}

export async function createStoryReadingIncomeSafely(
  payload
) {
  try {
    return await createStoryReadingIncome(
      payload
    )
  } catch (error) {
    console.error(
      'CREATE STORY READING INCOME ERROR:',
      error
    )
    return null
  }
}
