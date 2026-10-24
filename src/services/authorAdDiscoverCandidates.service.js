import { randomUUID } from 'node:crypto'
import { supabase } from '../config/supabase.js'
import { selectAuthorAdBoostSlots } from './authorAdBoostSlots.service.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const POOL_LIMIT = 64
const RESULT_LIMIT = 3
const INPUT_LIST_LIMIT = 100
const CAMPAIGN_COLUMNS = [
  'id', 'owner_user_id', 'author_page_id', 'campaign_kind', 'content_type', 'content_id',
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

function hasVerifiedBudget(campaign, funding) {
  const values = [
    campaign.budget_cents,
    campaign.funded_cents,
    campaign.refunded_cents,
    campaign.spent_cents,
  ].map(Number)
  if (!values.every(value => Number.isSafeInteger(value) && value >= 0)) return false
  const [budget, funded, refunded, spent] = values
  if (funding) {
    const diamonds = [
      funding.funded_diamonds,
      funding.spent_diamonds,
      funding.refunded_diamonds,
    ].map(Number)
    if (!diamonds.every(value => Number.isSafeInteger(value) && value >= 0)) return false
    const [fundedDiamonds, spentDiamonds, refundedDiamonds] = diamonds
    return funding.owner_user_id === campaign.owner_user_id &&
      budget > 0 && fundedDiamonds === budget &&
      funded === 0 && refunded === 0 && spent === 0 &&
      spentDiamonds + refundedDiamonds < fundedDiamonds
  }
  return budget > 0 && spent < budget &&
    funded - refunded >= budget && funded - refunded - spent > 0
}

async function loadCampaignPool(kind) {
  const pivot = randomUUID()
  const now = new Date().toISOString()
  const query = () => supabase.from('author_ad_campaigns')
    .select(CAMPAIGN_COLUMNS)
    .eq('status', 'active')
    .eq('review_status', 'approved')
    .eq('campaign_kind', kind)
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

async function loadCandidates(kind, input) {
  if (process.env.AUTHOR_ADS_DELIVERY_ENABLED !== 'true') return null
  if (kind === 'book' && process.env.AUTHOR_ADS_BOOK_DELIVERY_ENABLED !== 'true') return null
  const userId = requireUuid(input.viewerUserId, 'viewer ID')
  const limit = input.limit ?? RESULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > RESULT_LIMIT) {
    throw new RangeError('Invalid Discover Boost limit')
  }

  const excludedContent = idSet(
    kind === 'post' ? input.excludePostIds ?? [] : input.excludeContentIds ?? [],
    'excluded content IDs'
  )
  const excludedPages = idSet(input.excludeAuthorPageIds ?? [], 'excluded page IDs')
  const viewer = preferences({
    viewerGenres: input.viewerGenres ?? [],
    viewerLanguage: input.viewerLanguage ?? '',
    viewerCountry: input.viewerCountry ?? '',
  })
  const pool = await loadCampaignPool(kind)
  let candidates = pool.filter(campaign =>
    campaign.campaign_kind === kind &&
    (kind === 'post' ? campaign.content_type === 'post'
      : ['story', 'product'].includes(campaign.content_type)) &&
    UUID.test(String(campaign.id || '')) &&
    UUID.test(String(campaign.owner_user_id || '')) &&
    UUID.test(String(campaign.author_page_id || '')) &&
    UUID.test(String(campaign.content_id || '')) &&
    campaign.owner_user_id !== userId &&
    !excludedContent.has(campaign.content_id) &&
    !excludedPages.has(campaign.author_page_id) &&
    Array.isArray(campaign.placements) &&
    campaign.placements.includes('discover') &&
    matchingAudience(campaign, viewer)
  )
  if (!candidates.length) return { candidates: [], pages: new Map(), limit }

  const fundingResult = await supabase.from('author_ad_diamond_funding')
    .select('campaign_id,owner_user_id,funded_diamonds,spent_diamonds,refunded_diamonds')
    .in('campaign_id', candidates.map(item => item.id))
  const missingFundingTable = ['42P01', 'PGRST205'].includes(fundingResult.error?.code)
  if (fundingResult.error && !missingFundingTable) throw fundingResult.error
  const fundingByCampaign = new Map(
    (missingFundingTable ? [] : fundingResult.data || [])
      .map(item => [item.campaign_id, item])
  )
  candidates = candidates.filter(campaign =>
    hasVerifiedBudget(campaign, fundingByCampaign.get(campaign.id))
  )
  if (!candidates.length) return { candidates: [], pages: new Map(), limit }

  const pageIds = [...new Set(candidates.map(item => item.author_page_id))]
  const ownerIds = [...new Set(candidates.map(item => item.owner_user_id))]
  const [pages, blockedPages, blockedAccounts] = await Promise.all([
    supabase.from('author_pages').select('id,user_id')
      .in('id', pageIds).eq('status', 'active'),
    supabase.from('reader_blocked_author_pages').select('author_page_id')
      .eq('reader_user_id', userId).in('author_page_id', pageIds),
    supabase.from('chat_blocks').select('blocked_user_id')
      .eq('blocker_user_id', userId).in('blocked_user_id', ownerIds),
  ])
  for (const response of [pages, blockedPages, blockedAccounts]) {
    if (response.error) throw response.error
  }

  const blockedPageIds = new Set((blockedPages.data || []).map(item => item.author_page_id))
  const blockedUserIds = new Set((blockedAccounts.data || []).map(item => item.blocked_user_id))
  return {
    candidates: candidates.filter(item =>
      !blockedPageIds.has(item.author_page_id) && !blockedUserIds.has(item.owner_user_id)
    ),
    pages: new Map((pages.data || []).map(item => [item.id, item])),
    limit,
  }
}

export async function getEligibleDiscoverBoostPosts(input = {}) {
  const loaded = await loadCandidates('post', input)
  if (!loaded || !loaded.candidates.length) return []
  const postIds = [...new Set(loaded.candidates.map(item => item.content_id))]
  const posts = await supabase.from('author_page_posts')
    .select('id,author_page_id,user_id,image_urls')
    .in('id', postIds).eq('status', 'active')
  if (posts.error) throw posts.error

  const postsById = new Map((posts.data || []).map(item => [item.id, item]))
  const selected = []
  for (const campaign of loaded.candidates) {
    const post = postsById.get(campaign.content_id)
    const page = loaded.pages.get(campaign.author_page_id)
    if (!post || !page || page.user_id !== campaign.owner_user_id) continue
    if (post.author_page_id !== page.id || post.user_id !== page.user_id) continue
    if (!Array.isArray(post.image_urls) || !post.image_urls.some(url => typeof url === 'string' && url.trim())) continue
    selected.push({ campaignId: campaign.id, postId: post.id, authorPageId: page.id })
  }

  return selectAuthorAdBoostSlots({
    posts: selected,
    alreadyShown: input.alreadyShown ?? [],
  }).posts.slice(0, loaded.limit)
}

export async function getEligibleDiscoverBoostBooks(input = {}) {
  const loaded = await loadCandidates('book', input)
  if (!loaded || !loaded.candidates.length) return []
  const storyIds = [...new Set(loaded.candidates
    .filter(item => item.content_type === 'story').map(item => item.content_id))]
  const productIds = [...new Set(loaded.candidates
    .filter(item => item.content_type === 'product').map(item => item.content_id))]
  const [stories, products] = await Promise.all([
    storyIds.length ? supabase.from('stories')
      .select('id,author_id,cover_url').in('id', storyIds)
      .eq('status', 'published').is('deleted_at', null)
      : Promise.resolve({ data: [], error: null }),
    productIds.length ? supabase.from('author_store_products')
      .select('id,author_page_id,cover_url,product_type').in('id', productIds)
      .eq('status', 'active').in('product_type', ['book', 'pdf'])
      : Promise.resolve({ data: [], error: null }),
  ])
  if (stories.error) throw stories.error
  if (products.error) throw products.error

  const storiesById = new Map((stories.data || []).map(item => [item.id, item]))
  const productsById = new Map((products.data || []).map(item => [item.id, item]))
  const selected = []
  for (const campaign of loaded.candidates) {
    const page = loaded.pages.get(campaign.author_page_id)
    if (!page || page.user_id !== campaign.owner_user_id) continue
    const item = campaign.content_type === 'story'
      ? storiesById.get(campaign.content_id) : productsById.get(campaign.content_id)
    if (!item || typeof item.cover_url !== 'string' || !item.cover_url.trim()) continue
    if (campaign.content_type === 'story' && item.author_id !== page.id) continue
    if (campaign.content_type === 'product' && item.author_page_id !== page.id) continue
    selected.push({
      campaignId: campaign.id,
      contentType: campaign.content_type,
      contentId: item.id,
      authorPageId: page.id,
    })
  }

  return selectAuthorAdBoostSlots({
    books: selected,
    alreadyShown: input.alreadyShown ?? [],
  }).books.slice(0, loaded.limit)
}

export async function getEligibleDiscoverBoostSlots(input = {}) {
  if (process.env.AUTHOR_ADS_DELIVERY_ENABLED !== 'true') {
    return { posts: [], books: [] }
  }
  const [posts, books] = await Promise.all([
    getEligibleDiscoverBoostPosts(input),
    getEligibleDiscoverBoostBooks(input),
  ])
  return selectAuthorAdBoostSlots({ posts, books, alreadyShown: input.alreadyShown ?? [] })
}
