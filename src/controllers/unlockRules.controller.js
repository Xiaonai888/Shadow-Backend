import { supabase } from '../config/supabase.js'

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

function normalizeRules(rules) {
  const source = rules || FALLBACK_RULES

  return {
    diamond: {
      price_per_episode: Number(source.diamond_per_episode || FALLBACK_RULES.diamond_per_episode),
      access_type: 'permanent',
      relock: false,
      counts_as_author_revenue: true,
      fan_rule: 'Reader becomes an author fan after a paid Diamond unlock.',
    },
    gem: {
      price_per_episode: Number(source.gem_per_episode || FALLBACK_RULES.gem_per_episode),
      access_type: 'temporary',
      access_days: Number(source.gem_access_days || FALLBACK_RULES.gem_access_days),
      new_episode_wait_days: Number(source.gem_new_episode_wait_days || FALLBACK_RULES.gem_new_episode_wait_days),
      relock: true,
      daily_limits: {
        standard: Number(source.standard_gem_daily_limit || FALLBACK_RULES.standard_gem_daily_limit),
        vip: Number(source.vip_gem_daily_limit || FALLBACK_RULES.vip_gem_daily_limit),
        premium: Number(source.premium_gem_daily_limit || FALLBACK_RULES.premium_gem_daily_limit),
      },
      monthly_story_limits: {
        standard: Number(source.standard_gem_monthly_story_limit || FALLBACK_RULES.standard_gem_monthly_story_limit),
        vip: Number(source.vip_gem_monthly_story_limit || FALLBACK_RULES.vip_gem_monthly_story_limit),
        premium: Number(source.premium_gem_monthly_story_limit || FALLBACK_RULES.premium_gem_monthly_story_limit),
      },
    },
    free_first_episode: {
      login_required: true,
      monthly_limits: {
        standard: Number(source.standard_free_first_episode_monthly_limit || FALLBACK_RULES.standard_free_first_episode_monthly_limit),
        vip: Number(source.vip_free_first_episode_monthly_limit || FALLBACK_RULES.vip_free_first_episode_monthly_limit),
        premium: source.premium_free_first_episode_unlimited ? 'unlimited' : 0,
      },
    },
    voucher: {
      cost_per_episode: Number(source.voucher_cost_per_episode || FALLBACK_RULES.voucher_cost_per_episode),
      access_type: 'permanent',
      relock: false,
      story_scope: 'any_story',
    },
    story_card: {
      simple_card: {
        cost_per_episode: Number(source.simple_story_card_cost_per_episode || FALLBACK_RULES.simple_story_card_cost_per_episode),
        story_scope: 'same_story_only',
      },
      special_card: {
        cost_per_episode: Number(source.special_story_card_cost_per_episode || FALLBACK_RULES.special_story_card_cost_per_episode),
        story_scope: 'any_episode',
      },
      access_type: 'permanent',
      relock: false,
    },
    views: {
      unique_view_cooldown_hours: Number(source.view_count_cooldown_hours || FALLBACK_RULES.view_count_cooldown_hours),
    },
    ads: {
      show_after_free_unlock: Boolean(source.show_ads_after_free_unlock),
      duration_seconds: Number(source.free_unlock_ad_duration_seconds || FALLBACK_RULES.free_unlock_ad_duration_seconds),
      close_after_seconds: Number(source.free_unlock_ad_close_after_seconds || FALLBACK_RULES.free_unlock_ad_close_after_seconds),
      diamond_unlock_has_ads: false,
    },
  }
}

function publicRuleGuidelines(rules) {
  return [
    {
      title: 'Diamonds',
      body: `Unlock permanently for ${rules.diamond.price_per_episode} Diamonds per episode. Diamond unlocks count as paid author revenue.`,
    },
    {
      title: 'Gems',
      body: `Gem access lasts ${rules.gem.access_days} days, then the episode relocks. New episodes must wait ${rules.gem.new_episode_wait_days} days before Gem access is available.`,
    },
    {
      title: 'Gem Daily Limits',
      body: `Standard ${rules.gem.daily_limits.standard}/day, VIP ${rules.gem.daily_limits.vip}/day, Premium ${rules.gem.daily_limits.premium}/day.`,
    },
    {
      title: 'Gem Monthly Story Limits',
      body: `Standard ${rules.gem.monthly_story_limits.standard}/story/month, VIP ${rules.gem.monthly_story_limits.vip}/story/month, Premium ${rules.gem.monthly_story_limits.premium}/story/month.`,
    },
    {
  title: 'First 5 Episodes',
  body: `Episodes 1–5 are free. Paid unlocks and author income start from Episode 6. Login required. Standard ${rules.free_first_episode.monthly_limits.standard} stories/month, VIP ${rules.free_first_episode.monthly_limits.vip} stories/month, Premium unlimited.`,
},
    {
      title: 'Vouchers',
      body: `${rules.voucher.cost_per_episode} vouchers unlock 1 episode permanently in any story.`,
    },
    {
      title: 'Story Cards',
      body: `Simple cards need ${rules.story_card.simple_card.cost_per_episode} cards for 1 episode in the same story. Special cards need ${rules.story_card.special_card.cost_per_episode} card for any episode.`,
    },
    {
      title: 'Views',
      body: `A repeated view from the same user counts again only after ${rules.views.unique_view_cooldown_hours} hours.`,
    },
    {
      title: 'Free Unlock Ads',
      body: `Free unlock methods may show an ad for ${rules.ads.duration_seconds} seconds. Close button appears after ${rules.ads.close_after_seconds} seconds. Diamond unlocks do not show ads.`,
    },
  ]
}

export async function getPlatformUnlockRules(req, res) {
  try {
    const { data, error } = await supabase
      .from('platform_unlock_rules')
      .select('*')
      .eq('id', 1)
      .maybeSingle()

    if (error) throw error

    const rules = normalizeRules(data || FALLBACK_RULES)

    return res.status(200).json({
      ok: true,
      rules,
      guidelines: publicRuleGuidelines(rules),
      source: data ? 'database' : 'fallback',
    })
  } catch (error) {
    console.error('GET PLATFORM UNLOCK RULES ERROR:', error)

    const rules = normalizeRules(FALLBACK_RULES)

    return res.status(200).json({
      ok: true,
      rules,
      guidelines: publicRuleGuidelines(rules),
      source: 'fallback',
      warning: 'Database rules could not be loaded.',
    })
  }
}
