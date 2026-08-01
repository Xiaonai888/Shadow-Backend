function numberValue(value) {
  const number = Number(value || 0)

  if (!Number.isFinite(number)) return 0

  return number
}

function roundValue(value) {
  return Math.round((numberValue(value) + Number.EPSILON) * 1000000) / 1000000
}

function clampPercent(value) {
  const number = numberValue(value)

  if (number <= 0) return 0
  if (number >= 100) return 100

  return roundValue(number)
}

function positiveAmount(value) {
  const number = numberValue(value)

  if (number <= 0) return 0

  return roundValue(number)
}

const MAX_TOTAL_DISCOUNT_PERCENT = 90

export function getAdditiveDiscountResult(originalAmount, discountItems = []) {
  const baseAmount = positiveAmount(originalAmount)
  const appliedDiscounts = (Array.isArray(discountItems) ? discountItems : [])
    .filter((item) => item && item.active !== false)
    .map((item) => ({
      key: String(item.key || '').trim(),
      label: String(item.label || item.key || 'Discount').trim(),
      percent: clampPercent(item.percent),
    }))
    .filter((item) => item.percent > 0)

  const rawTotalDiscountPercent = appliedDiscounts.reduce(
    (sum, item) => sum + item.percent,
    0
  )
  const totalDiscountPercent = Math.min(
    MAX_TOTAL_DISCOUNT_PERCENT,
    roundValue(rawTotalDiscountPercent)
  )
  const discountAmount = roundValue(
    baseAmount * (totalDiscountPercent / 100)
  )
  const finalPaidAmount = roundValue(
    Math.max(0, baseAmount - discountAmount)
  )

  return {
    original_amount: baseAmount,
    applied_discounts: appliedDiscounts,
    raw_total_discount_percent: roundValue(rawTotalDiscountPercent),
    total_discount_percent: totalDiscountPercent,
    discount_amount: discountAmount,
    final_paid_amount: finalPaidAmount,
  }
}

export function resolveEffectiveAuthorShare({
  questSharePercent = 0,
  eventSharePercent = 0,
  boostSharePercent = 0,
} = {}) {
  const candidates = [
    {
      source: 'quest_stage',
      percent: clampPercent(questSharePercent),
    },
    {
      source: 'event',
      percent: clampPercent(eventSharePercent),
    },
    {
      source: 'creator_boost',
      percent: clampPercent(boostSharePercent),
    },
  ]

  const best = candidates.sort((a, b) => b.percent - a.percent)[0] || {
    source: 'quest_stage',
    percent: 0,
  }

  return {
    effective_author_share_percent: best.percent,
    effective_share_source: best.source,
    quest_share_percent: clampPercent(questSharePercent),
    event_share_percent: clampPercent(eventSharePercent),
    boost_share_percent: clampPercent(boostSharePercent),
  }
}

export function splitDistributableRevenue({
  distributableNetRevenue = 0,
  authorSharePercent = 0,
} = {}) {
  const netRevenue = positiveAmount(distributableNetRevenue)
  const sharePercent = clampPercent(authorSharePercent)
  const authorRevenue = roundValue(
    netRevenue * (sharePercent / 100)
  )
  const platformRevenue = roundValue(
    Math.max(0, netRevenue - authorRevenue)
  )

  return {
    distributable_net_revenue: netRevenue,
    author_share_percent: sharePercent,
    author_revenue: authorRevenue,
    platform_revenue: platformRevenue,
  }
}

export function buildRevenueDecision({
  originalAmount = 0,
  directCostAmount = 0,
  discountItems = [],
  questSharePercent = 0,
  eventSharePercent = 0,
  boostSharePercent = 0,
} = {}) {
  const pricing = getAdditiveDiscountResult(
    originalAmount,
    discountItems
  )
  const directCosts = positiveAmount(directCostAmount)
  const distributableNetRevenue = roundValue(
    Math.max(0, pricing.final_paid_amount - directCosts)
  )
  const share = resolveEffectiveAuthorShare({
    questSharePercent,
    eventSharePercent,
    boostSharePercent,
  })
  const split = splitDistributableRevenue({
    distributableNetRevenue,
    authorSharePercent:
      share.effective_author_share_percent,
  })

  return {
    original_amount: pricing.original_amount,
    applied_discounts: pricing.applied_discounts,
    raw_total_discount_percent:
      pricing.raw_total_discount_percent,
    total_discount_percent:
      pricing.total_discount_percent,
    discount_amount: pricing.discount_amount,
    final_paid_amount: pricing.final_paid_amount,
    direct_cost_amount: directCosts,
    distributable_net_revenue:
      split.distributable_net_revenue,
    quest_share_percent:
      share.quest_share_percent,
    event_share_percent:
      share.event_share_percent,
    boost_share_percent:
      share.boost_share_percent,
    effective_author_share_percent:
      share.effective_author_share_percent,
    effective_share_source:
      share.effective_share_source,
    author_revenue: split.author_revenue,
    platform_revenue:
      split.platform_revenue,
  }
}

export {
  MAX_TOTAL_DISCOUNT_PERCENT,
}
