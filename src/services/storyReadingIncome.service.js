import { supabase } from '../config/supabase.js'

const DEFAULT_DIAMOND_TO_USD_RATE = 0.01
const PLATFORM_SHARE_PERCENT = 50
const AUTHOR_SHARE_PERCENT = 50

function numberValue(value) {
  const number = Number(value || 0)
  return Number.isFinite(number) ? number : 0
}

function nonNegativeInteger(value) {
  return Math.max(0, Math.floor(numberValue(value)))
}

function percentValue(value) {
  return Math.max(0, Math.min(100, numberValue(value)))
}

async function getDiamondToUsdRate() {
  const { data, error } = await supabase
    .from('author_revenue_settings')
    .select('diamond_to_usd_rate')
    .eq('id', 1)
    .maybeSingle()

  if (error) {
    console.error('GET STORY READING DIAMOND RATE ERROR:', error)
    return DEFAULT_DIAMOND_TO_USD_RATE
  }

  const rate = numberValue(data?.diamond_to_usd_rate)
  return rate > 0 ? rate : DEFAULT_DIAMOND_TO_USD_RATE
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
  metadata = {},
}) {
  const cleanPurchaseKey = String(purchaseKey || '').trim()
  const cleanReaderId = String(readerId || '').trim()
  const cleanStoryId = String(storyId || '').trim()
  const finalPaidDiamonds = nonNegativeInteger(paidDiamonds)

  if (!cleanPurchaseKey || !cleanReaderId || !cleanStoryId || finalPaidDiamonds <= 0) {
    return null
  }

  const diamondToUsdRate = await getDiamondToUsdRate()
  const payload = {
    purchase_key: cleanPurchaseKey,
    reader_id: cleanReaderId,
    story_id: cleanStoryId,
    author_id: authorId || null,
    first_episode_id: firstEpisodeId || null,
    package_key: String(packageKey || 'single').trim() || 'single',
    episode_count: Math.max(1, nonNegativeInteger(episodeCount)),
    currency: 'diamond',
    original_diamonds: nonNegativeInteger(originalDiamonds),
    package_discount_percent: percentValue(packageDiscountPercent),
    black_sunday_discount_percent: percentValue(blackSundayDiscountPercent),
    paid_diamonds: finalPaidDiamonds,
    diamond_to_usd_rate: diamondToUsdRate,
    platform_share_percent: PLATFORM_SHARE_PERCENT,
    author_share_percent: AUTHOR_SHARE_PERCENT,
    income_status: 'completed',
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    updated_at: new Date().toISOString(),
  }

  const { data, error } = await supabase
    .from('story_reading_income_transactions')
    .upsert(payload, {
      onConflict: 'purchase_key',
      ignoreDuplicates: true,
    })
    .select()
    .maybeSingle()

  if (error) throw error
  return data || null
}

export async function createStoryReadingIncomeSafely(payload) {
  try {
    return await createStoryReadingIncome(payload)
  } catch (error) {
    console.error('CREATE STORY READING INCOME ERROR:', error)
    return null
  }
}
