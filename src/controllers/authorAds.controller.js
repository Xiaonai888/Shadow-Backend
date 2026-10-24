import { supabase } from '../config/supabase.js'
import { transitionOwnedAuthorAdCampaign } from '../services/authorAdLifecycle.service.js'

const CAMPAIGN_STATUSES = new Set([
  'draft', 'pending_review', 'approved', 'scheduled', 'active',
  'paused', 'completed', 'rejected', 'cancelled',
])
const GENRES = new Set([
  'Romance', 'Fantasy', 'Action', 'Adventure', 'Horror', 'Mystery',
  'Drama', 'Comedy', 'Historical', 'Sci-Fi', 'LGBTQ+',
])
const LANGUAGES = new Set(['km', 'en', 'zh', 'ko', 'ja'])
const COUNTRIES = new Set(['KH', 'TH', 'VN'])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const GOALS = {
  post: new Set(['views', 'visits', 'followers']),
  story: new Set(['readers', 'followers', 'unlocks']),
  product: new Set(['sales', 'followers']),
}
const CAMPAIGN_RETURN_COLUMNS = [
  'id', 'campaign_kind', 'content_type', 'content_id',
  'content_title', 'content_image_url', 'goal', 'audience_mode',
  'audience_filters', 'placements', 'budget_cents', 'funded_cents',
  'spent_cents', 'refunded_cents', 'duration_days', 'status',
  'review_status', 'review_reason', 'submitted_at', 'start_at',
  'end_at', 'created_at', 'updated_at',
].join(',')

function apiError(status, code, message) {
  const error = new Error(message)
  error.httpStatus = status
  error.publicCode = code
  return error
}

function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw apiError(400, 'INVALID_CAMPAIGN', 'Campaign details must be an object')
  }
  return value
}

function requireUuid(value, field) {
  const id = String(value ?? '').trim()
  if (!UUID_PATTERN.test(id)) {
    throw apiError(400, 'INVALID_ID', `Invalid ${field}`)
  }
  return id
}

function normalizeBudgetCents(body) {
  if (body.budget_cents !== undefined) {
    const amount = Number(body.budget_cents)
    if (!Number.isSafeInteger(amount) || amount < 100 || amount > 1000000) {
      throw apiError(400, 'INVALID_BUDGET', 'Budget must be between $1 and $10,000')
    }
    return amount
  }

  const value = String(body.budgetUsd ?? body.budget_usd ?? '').trim()
  if (!/^\d{1,5}(?:\.\d{1,2})?$/.test(value)) {
    throw apiError(400, 'INVALID_BUDGET', 'Enter a valid USD budget')
  }
  const [dollars, cents = ''] = value.split('.')
  const amount = Number(dollars) * 100 + Number(cents.padEnd(2, '0'))
  if (amount < 100 || amount > 1000000) {
    throw apiError(400, 'INVALID_BUDGET', 'Budget must be between $1 and $10,000')
  }
  return amount
}

function normalizeAudience(body) {
  const audience = body.audience === undefined ? {} : requireObject(body.audience)
  const mode = String(body.audience_mode ?? audience.mode ?? 'automatic').trim()
  if (!['automatic', 'manual'].includes(mode)) {
    throw apiError(400, 'INVALID_AUDIENCE', 'Invalid audience selection')
  }
  if (mode === 'automatic') {
    return { audience_mode: mode, audience_filters: {} }
  }

  const filters = body.audience_filters === undefined
    ? audience
    : requireObject(body.audience_filters)
  const genre = String(filters.genre ?? '').trim()
  const language = String(filters.language ?? '').trim().toLowerCase()
  const country = String(filters.country ?? '').trim().toUpperCase()
  if ((genre && !GENRES.has(genre)) ||
      (language && !LANGUAGES.has(language)) ||
      (country && !COUNTRIES.has(country))) {
    throw apiError(400, 'INVALID_AUDIENCE', 'Invalid genre, language or country')
  }
  return {
    audience_mode: mode,
    audience_filters: { genre, language, country },
  }
}

function parseCampaign(body) {
  requireObject(body)
  const campaignKind = String(body.kind ?? body.campaign_kind ?? '').trim()
  const contentType = String(body.contentType ?? body.content_type ?? '').trim()
  const contentId = requireUuid(body.contentId ?? body.content_id, 'content ID')
  const goal = String(body.goal ?? '').trim()
  const durationDays = Number(body.durationDays ?? body.duration_days)
  const placements = body.placements ?? ['discover']

  if (!['post', 'book'].includes(campaignKind) ||
      (campaignKind === 'post' && contentType !== 'post') ||
      (campaignKind === 'book' && !['story', 'product'].includes(contentType))) {
    throw apiError(400, 'INVALID_CONTENT_TYPE', 'Invalid Boost Post or Boost Book selection')
  }
  if (!GOALS[contentType].has(goal)) {
    throw apiError(400, 'INVALID_GOAL', 'Goal is not available for this content type')
  }
  if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 30) {
    throw apiError(400, 'INVALID_DURATION', 'Duration must be between 1 and 30 days')
  }
  if (!Array.isArray(placements) || placements.length !== 1 || placements[0] !== 'discover') {
    throw apiError(400, 'INVALID_PLACEMENT', 'Only Discover is supported')
  }

  return {
    campaign_kind: campaignKind,
    content_type: contentType,
    content_id: contentId,
    goal,
    ...normalizeAudience(body),
    placements: ['discover'],
    budget_cents: normalizeBudgetCents(body),
    duration_days: durationDays,
  }
}

async function getOwnedAuthorPage(userId) {
  const { data, error } = await supabase
    .from('author_pages')
    .select('id, user_id, status')
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle()
  if (error) throw error
  if (!data) throw apiError(403, 'AUTHOR_PAGE_REQUIRED', 'An active Author Page is required')
  return data
}

async function getAuthorizedContent(page, userId, campaign) {
  const { content_type: contentType, content_id: contentId } = campaign
  let query

  if (contentType === 'post') {
    query = supabase.from('author_page_posts')
      .select('id, content, image_urls, status')
      .eq('id', contentId)
      .eq('author_page_id', page.id)
      .eq('user_id', userId)
      .eq('status', 'active')
  } else if (contentType === 'story') {
    query = supabase.from('stories')
      .select('id, title, cover_url, status')
      .eq('id', contentId)
      .eq('author_id', page.id)
      .eq('status', 'published')
      .is('deleted_at', null)
  } else {
    query = supabase.from('author_store_products')
      .select('id, title, cover_url, product_type, status')
      .eq('id', contentId)
      .eq('author_page_id', page.id)
      .eq('status', 'active')
      .in('product_type', ['book', 'pdf'])
  }

  const { data, error } = await query.maybeSingle()
  if (error) throw error
  if (!data) {
    throw apiError(404, 'CONTENT_NOT_AVAILABLE', 'Published content not found on your Author Page')
  }

  if (contentType === 'post') {
    const imageUrls = Array.isArray(data.image_urls) ? data.image_urls : []
    if (!imageUrls.some(item => typeof item === 'string' && item.trim())) {
      throw apiError(400, 'PHOTO_REQUIRED', 'Boost Post requires a published photo post')
    }
    const title = String(data.content || '').trim().split(/\r?\n/).find(Boolean) || 'Photo post'
    return {
      content_title: title.slice(0, 220),
      content_image_url: String(imageUrls.find(item => typeof item === 'string' && item.trim()) || '').slice(0, 2000),
    }
  }

  return {
    content_title: String(data.title || 'Untitled').trim().slice(0, 220),
    content_image_url: String(data.cover_url || '').trim().slice(0, 2000),
  }
}

async function getOwnedCampaign(id, page, userId) {
  const { data, error } = await supabase.from('author_ad_campaigns')
    .select(CAMPAIGN_RETURN_COLUMNS)
    .eq('id', id)
    .eq('author_page_id', page.id)
    .eq('owner_user_id', userId)
    .maybeSingle()
  if (error) throw error
  if (!data) throw apiError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found')
  return data
}

function publicCampaign(row) {
  return {
    id: row.id,
    kind: row.campaign_kind,
    contentType: row.content_type,
    contentId: row.content_id,
    contentKey: `${row.content_type}:${row.content_id}`,
    contentTitle: row.content_title,
    contentImage: row.content_image_url,
    goal: row.goal,
    audience: {
      mode: row.audience_mode,
      genre: row.audience_filters?.genre || '',
      language: row.audience_filters?.language || '',
      country: row.audience_filters?.country || '',
    },
    placements: row.placements,
    budgetUsd: Number(row.budget_cents) / 100,
    fundedUsd: Number(row.funded_cents) / 100,
    spentUsd: Number(row.spent_cents) / 100,
    refundedUsd: Number(row.refunded_cents) / 100,
    durationDays: row.duration_days,
    status: row.status,
    reviewStatus: row.review_status,
    reviewReason: row.review_reason || '',
    submittedAt: row.submitted_at,
    startAt: row.start_at,
    endAt: row.end_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function respond(res, handler) {
  try {
    return await handler()
  } catch (error) {
    if (error?.httpStatus) {
      return res.status(error.httpStatus).json({
        ok: false,
        code: error.publicCode,
        message: error.message,
      })
    }
    if (error?.code === '42P01' || error?.code === 'PGRST205') {
      return res.status(503).json({
        ok: false,
        code: 'AUTHOR_ADS_NOT_CONFIGURED',
        message: 'Author Ads database is not ready',
      })
    }
    console.error('AUTHOR ADS CONTROLLER ERROR:', error)
    return res.status(500).json({
      ok: false,
      code: 'AUTHOR_ADS_ERROR',
      message: 'Unable to complete the Author Ads request',
    })
  }
}

function authenticatedUserId(req) {
  const userId = req.user?.user_id
  if (!userId || !UUID_PATTERN.test(String(userId))) {
    throw apiError(401, 'AUTH_REQUIRED', 'Please sign in to continue')
  }
  return String(userId)
}

export async function listMyAuthorAdCampaigns(req, res) {
  return respond(res, async () => {
    const userId = authenticatedUserId(req)
    const page = await getOwnedAuthorPage(userId)
    const requestedLimit = Number(req.query.limit || 20)
    const requestedPage = Number(req.query.page || 1)
    if (!Number.isInteger(requestedLimit) || !Number.isInteger(requestedPage) ||
        requestedLimit < 1 || requestedLimit > 50 || requestedPage < 1 || requestedPage > 10000) {
      throw apiError(400, 'INVALID_PAGE', 'Invalid campaign pagination')
    }
    const status = String(req.query.status || '').trim()
    if (status && status !== 'all' && !CAMPAIGN_STATUSES.has(status)) {
      throw apiError(400, 'INVALID_STATUS', 'Invalid campaign status')
    }
    let query = supabase.from('author_ad_campaigns')
      .select(CAMPAIGN_RETURN_COLUMNS, { count: 'exact' })
      .eq('owner_user_id', userId)
      .eq('author_page_id', page.id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range((requestedPage - 1) * requestedLimit, requestedPage * requestedLimit - 1)
    if (status && status !== 'all') query = query.eq('status', status)
    const { data, count, error } = await query
    if (error) throw error
    return res.json({
      ok: true,
      campaigns: (data || []).map(publicCampaign),
      total: Number(count || 0),
      page: requestedPage,
      limit: requestedLimit,
      has_more: requestedPage * requestedLimit < Number(count || 0),
    })
  })
}

export async function getMyAuthorAdCampaign(req, res) {
  return respond(res, async () => {
    const userId = authenticatedUserId(req)
    const page = await getOwnedAuthorPage(userId)
    const id = requireUuid(req.params.campaignId, 'campaign ID')
    const campaign = await getOwnedCampaign(id, page, userId)
    return res.json({ ok: true, campaign: publicCampaign(campaign) })
  })
}

export async function createMyAuthorAdDraft(req, res) {
  return respond(res, async () => {
    const userId = authenticatedUserId(req)
    const page = await getOwnedAuthorPage(userId)
    const input = parseCampaign(req.body)
    const content = await getAuthorizedContent(page, userId, input)
    const { data, error } = await supabase.from('author_ad_campaigns')
      .insert({
        owner_user_id: userId,
        author_page_id: page.id,
        ...input,
        ...content,
        status: 'draft',
        review_status: 'not_submitted',
      })
      .select(CAMPAIGN_RETURN_COLUMNS)
      .single()
    if (error) throw error
    return res.status(201).json({ ok: true, campaign: publicCampaign(data) })
  })
}

export async function updateMyAuthorAdDraft(req, res) {
  return respond(res, async () => {
    const userId = authenticatedUserId(req)
    const page = await getOwnedAuthorPage(userId)
    const id = requireUuid(req.params.campaignId, 'campaign ID')
    const current = await getOwnedCampaign(id, page, userId)
    if (current.status !== 'draft' || current.review_status !== 'not_submitted' ||
        Number(current.funded_cents) !== 0 || Number(current.spent_cents) !== 0) {
      throw apiError(409, 'DRAFT_LOCKED', 'Only unfunded, unsubmitted drafts can be edited')
    }
    const input = parseCampaign(req.body)
    const content = await getAuthorizedContent(page, userId, input)
    const { data, error } = await supabase.from('author_ad_campaigns')
      .update({ ...input, ...content })
      .eq('id', id)
      .eq('owner_user_id', userId)
      .eq('author_page_id', page.id)
      .eq('status', 'draft')
      .eq('review_status', 'not_submitted')
      .eq('funded_cents', 0)
      .eq('spent_cents', 0)
      .select(CAMPAIGN_RETURN_COLUMNS)
      .maybeSingle()
    if (error) throw error
    if (!data) throw apiError(409, 'DRAFT_LOCKED', 'Draft was changed. Please refresh')
    return res.json({ ok: true, campaign: publicCampaign(data) })
  })
}

export async function deleteMyAuthorAdDraft(req, res) {
  return respond(res, async () => {
    const userId = authenticatedUserId(req)
    const page = await getOwnedAuthorPage(userId)
    const id = requireUuid(req.params.campaignId, 'campaign ID')
    const current = await getOwnedCampaign(id, page, userId)
    if (current.status !== 'draft' || current.review_status !== 'not_submitted' ||
        Number(current.funded_cents) !== 0 || Number(current.spent_cents) !== 0 ||
        Number(current.refunded_cents) !== 0) {
      throw apiError(409, 'DRAFT_LOCKED', 'Only unfunded drafts can be deleted')
    }
    const { data, error } = await supabase.from('author_ad_campaigns')
      .delete()
      .eq('id', id)
      .eq('owner_user_id', userId)
      .eq('author_page_id', page.id)
      .eq('status', 'draft')
      .eq('review_status', 'not_submitted')
      .eq('funded_cents', 0)
      .eq('spent_cents', 0)
      .eq('refunded_cents', 0)
      .select('id')
      .maybeSingle()
    if (error) throw error
    if (!data) throw apiError(409, 'DRAFT_LOCKED', 'Draft was changed. Please refresh')
    return res.json({ ok: true, deleted_id: id })
  })
}

export async function submitMyAuthorAdForReview(req, res) {
  return respond(res, async () => {
    const userId = authenticatedUserId(req)
    const page = await getOwnedAuthorPage(userId)
    const id = requireUuid(req.params.campaignId, 'campaign ID')
    const current = await getOwnedCampaign(id, page, userId)
    if (current.status !== 'draft' || current.review_status !== 'not_submitted' ||
        Number(current.funded_cents) !== 0 || Number(current.spent_cents) !== 0) {
      throw apiError(409, 'DRAFT_LOCKED', 'Campaign is not eligible for review')
    }
    const content = await getAuthorizedContent(page, userId, current)
    const { data, error } = await supabase.from('author_ad_campaigns')
      .update({
        ...content,
        status: 'pending_review',
        review_status: 'pending',
        submitted_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('owner_user_id', userId)
      .eq('author_page_id', page.id)
      .eq('status', 'draft')
      .eq('review_status', 'not_submitted')
      .eq('funded_cents', 0)
      .eq('spent_cents', 0)
      .select(CAMPAIGN_RETURN_COLUMNS)
      .maybeSingle()
    if (error) throw error
    if (!data) throw apiError(409, 'DRAFT_LOCKED', 'Draft was changed. Please refresh')
    return res.json({
      ok: true,
      campaign: publicCampaign(data),
      payment_required: true,
      delivery_active: false,
    })
  })
}

export async function transitionMyAuthorAdCampaign(req, res) {
  return respond(res, async () => {
    res.set('Cache-Control', 'private, no-store')
    const userId = authenticatedUserId(req)
    const id = requireUuid(req.params.campaignId, 'campaign ID')
    const action = req.body?.action

    if (typeof action !== 'string' || !['start', 'pause', 'resume'].includes(action)) {
      throw apiError(400, 'INVALID_CAMPAIGN_ACTION', 'Choose start, pause or resume')
    }

    const transition = await transitionOwnedAuthorAdCampaign({
      campaignId: id,
      ownerUserId: userId,
      action,
    })

    const { data, error } = await supabase.from('author_ad_campaigns')
      .select(CAMPAIGN_RETURN_COLUMNS)
      .eq('id', id)
      .eq('owner_user_id', userId)
      .maybeSingle()

    if (error) throw error
    if (!data) throw apiError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found')

    return res.json({
      ok: true,
      changed: transition.changed,
      campaign: publicCampaign(data),
      payment_required: Number(data.funded_cents) - Number(data.refunded_cents) < Number(data.budget_cents),
      delivery_active: data.status === 'active',
    })
  })
}
