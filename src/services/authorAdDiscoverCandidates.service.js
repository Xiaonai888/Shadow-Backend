import { randomUUID } from 'node:crypto'
import { supabase } from '../config/supabase.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const POOL_LIMIT = 64
const RESULT_LIMIT = 9
const INPUT_LIST_LIMIT = 100
const CAMPAIGN_COLUMNS = [
  'id', 'owner_user_id', 'author_page_id', 'content_id',
  'audience_mode', 'audience_filters', 'placements',
  'budget_cents', 'funded_cents', 'refunded_cents', 'spent_cents',
].join(',')

function requireUuid(value, name) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new TypeError(`Invalid ${name}`)
  }
  return value
}

function idSet(value, name) {
  if (!Array.isArray(value) || value.length > INPUT_LIST_LIMIT) {
    throw new TypeError(`Invalid ${name}`)
  }
  return new Set(value.map(id => requireUuid(id, name)))
}

function preference(value, maximum = 64) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return text.length <= maximum ? text : ''
}

function preferences(input) {
  if (!Array.isArray(input.viewerGenres) || input.viewerGenres.length > 24) {
    throw new TypeError('Invalid viewer genres')
  }
  return {
    genres: new Set(input.viewerGenres.map(value => preference(value)).filter(Boolean)),
    language: preference(input.viewerLanguage, 12),
    country: preference(input.viewerCountry, 3),
  }
}

function matchingAudience(campaign, viewer) {
  if (campaign.audience_mode === 'automatic') return true
  if (campaign.audience_mode !== 'manual') return false
  const filters = campaign.audience_filters
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) return false
  const genre = preference(filters.genre)
  const language = preference(filters.language, 12)
  const country = preference(filters.country, 3)
  if (genre && !viewer.genres.has(genre)) return false
  if (language && language !== viewer.language) return false
  if (country && country !== viewer.country) return false
  return true
}

function hasVerifiedBudget(campaign) {
  const values = [
    campaign.budget_cents,
    campaign.funded_cents,
    campaign.refunded_cents,
    campaign.spent_cents,
  ].map(Number)
  if (!values.every(value => Number.isSafeInteger(value) && value >= 0)) return false
  const [budget, funded, refunded, spent] = values
  return budget > 0 && spent < budget && funded - refunded >= budget && funded - refunded - spent > 0
}

async function loadCampaignPool() {
  const pivot = randomUUID()
  const now = new Date().toISOString()
  const query = () => supabase.from('author_ad_campaigns')
    .select(CAMPAIGN_COLUMNS)
    .eq('status', 'active')
    .eq('review_status', 'approved')
    .eq('campaign_kind', 'post')
    .eq('content_type', 'post')
    .eq('currency', 'USD')
    .lte('start_at', now)
    .gt('end_at', now)
    .contains('placements', ['discover'])

  const first = await query().gte('id', pivot).order('id', { ascending: true }).limit(POOL_LIMIT)
  if (first.error) throw first.error
  const candidates = first.data || []

  if (candidates.length < POOL_LIMIT) {
    const wrapped = await query().lt('id', pivot)
      .order('id', { ascending: true }).limit(POOL_LIMIT - candidates.length)
    if (wrapped.error) throw wrapped.error
    candidates.push(...(wrapped.data || []))
  }

  return candidates
}

export async function getEligibleDiscoverBoostPosts({
  viewerUserId,
  limit = 3,
  viewerGenres = [],
  viewerLanguage = '',
  viewerCountry = '',
  excludePostIds = [],
  excludeAuthorPageIds = [],
} = {}) {
  if (process.env.AUTHOR_ADS_DELIVERY_ENABLED !== 'true') return []

  const userId = requireUuid(viewerUserId, 'viewer ID')
  if (!Number.isInteger(limit) || limit < 1 || limit > RESULT_LIMIT) {
    throw new RangeError('Invalid Discover Boost limit')
  }

  const excludedPosts = idSet(excludePostIds, 'excluded post IDs')
  const excludedPages = idSet(excludeAuthorPageIds, 'excluded page IDs')
  const viewer = preferences({ viewerGenres, viewerLanguage, viewerCountry })
  const pool = await loadCampaignPool()
  const candidates = pool.filter(campaign =>
    UUID.test(String(campaign.id || '')) &&
    UUID.test(String(campaign.owner_user_id || '')) &&
    UUID.test(String(campaign.author_page_id || '')) &&
    UUID.test(String(campaign.content_id || '')) &&
    campaign.owner_user_id !== userId &&
    !excludedPosts.has(campaign.content_id) &&
    !excludedPages.has(campaign.author_page_id) &&
    Array.isArray(campaign.placements) &&
    campaign.placements.includes('discover') &&
    hasVerifiedBudget(campaign) &&
    matchingAudience(campaign, viewer)
  )
  if (!candidates.length) return []

  const postIds = [...new Set(candidates.map(item => item.content_id))]
  const pageIds = [...new Set(candidates.map(item => item.author_page_id))]
  const ownerIds = [...new Set(candidates.map(item => item.owner_user_id))]

  const [posts, pages, blockedPages, blockedAccounts] = await Promise.all([
    supabase.from('author_page_posts')
      .select('id,author_page_id,user_id,image_urls')
      .in('id', postIds).eq('status', 'active'),
    supabase.from('author_pages')
      .select('id,user_id')
      .in('id', pageIds).eq('status', 'active'),
    supabase.from('reader_blocked_author_pages')
      .select('author_page_id')
      .eq('reader_user_id', userId).in('author_page_id', pageIds),
    supabase.from('chat_blocks')
      .select('blocked_user_id')
      .eq('blocker_user_id', userId).in('blocked_user_id', ownerIds),
  ])
  for (const response of [posts, pages, blockedPages, blockedAccounts]) {
    if (response.error) throw response.error
  }

  const postsById = new Map((posts.data || []).map(item => [item.id, item]))
  const pagesById = new Map((pages.data || []).map(item => [item.id, item]))
  const blockedPageIds = new Set((blockedPages.data || []).map(item => item.author_page_id))
  const blockedUserIds = new Set((blockedAccounts.data || []).map(item => item.blocked_user_id))
  const seenPosts = new Set()
  const selected = []

  for (const campaign of candidates) {
    if (blockedPageIds.has(campaign.author_page_id) || blockedUserIds.has(campaign.owner_user_id)) continue
    const post = postsById.get(campaign.content_id)
    const page = pagesById.get(campaign.author_page_id)
    if (!post || !page || page.user_id !== campaign.owner_user_id) continue
    if (post.author_page_id !== page.id || post.user_id !== page.user_id) continue
    if (!Array.isArray(post.image_urls) || !post.image_urls.some(url => typeof url === 'string' && url.trim())) continue
    if (seenPosts.has(post.id)) continue

    seenPosts.add(post.id)
    selected.push({
      campaignId: campaign.id,
      postId: post.id,
      authorPageId: page.id,
    })
    if (selected.length >= limit) break
  }

  return selected
}
