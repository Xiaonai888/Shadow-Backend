import { supabase } from '../config/supabase.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_PAGE_LIMIT = 50
const CAMPAIGN_RETURN_COLUMNS = [
  'id', 'author_page_id', 'owner_user_id', 'campaign_kind',
  'content_type', 'content_id', 'content_title', 'content_image_url',
  'goal', 'audience_mode', 'audience_filters', 'placements',
  'budget_cents', 'funded_cents', 'spent_cents', 'refunded_cents',
  'duration_days', 'status', 'review_status', 'review_reason',
  'reviewed_by', 'reviewed_at', 'submitted_at', 'start_at',
  'end_at', 'created_at', 'updated_at',
].join(', ')
const STATUSES = new Set([
  'draft', 'pending_review', 'approved', 'scheduled', 'active',
  'paused', 'completed', 'rejected', 'cancelled',
])
const EVENT_TYPES = [
  'impression', 'click', 'reading_start', 'follow', 'unlock', 'purchase',
]
const RESULT_EVENTS = {
  readers: 'reading_start',
  followers: 'follow',
  unlocks: 'unlock',
  sales: 'purchase',
}

function fail(status, code, message) {
  const error = new Error(message)
  error.httpStatus = status
  error.publicCode = code
  throw error
}

async function respond(res, handler) {
  res.set('Cache-Control', 'private, no-store')
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
    console.error('ADMIN AUTHOR ADS ERROR:', error)
    return res.status(500).json({
      ok: false,
      code: 'ADMIN_AUTHOR_ADS_ERROR',
      message: 'Unable to complete the Author Ads request',
    })
  }
}

function requireAdminIdentity(req) {
  const role = String(req.admin?.role || '').trim().toLowerCase()
  if (!['owner', 'admin'].includes(role)) {
    fail(403, 'ADMIN_REQUIRED', 'Owner or admin access required')
  }
  return req.admin
}

function requireId(value) {
  const id = String(value || '').trim()
  if (!UUID_PATTERN.test(id)) fail(400, 'INVALID_CAMPAIGN_ID', 'Invalid Campaign ID')
  return id
}

function money(cents) {
  return Number(cents || 0) / 100
}

function campaignResult(row, funding = null) {
  const budget = Number(row.budget_cents)
  const usd = [row.funded_cents, row.spent_cents, row.refunded_cents].map(Number)
  if (!Number.isSafeInteger(budget) || budget < 100 ||
    !usd.every(value => Number.isSafeInteger(value) && value >= 0)) {
    fail(503, 'INVALID_CAMPAIGN_FUNDING', 'Campaign funding values are invalid')
  }
  const [fundedUsd, spentUsd, refundedUsd] = usd
  const hasDiamondFunding = Boolean(funding)
  const diamonds = hasDiamondFunding
    ? [funding.funded_diamonds, funding.spent_diamonds, funding.refunded_diamonds].map(Number)
    : [0, 0, 0]
  const [fundedDiamonds, spentDiamonds, refundedDiamonds] = diamonds
  if (hasDiamondFunding && (
    funding.campaign_id !== row.id || funding.owner_user_id !== row.owner_user_id ||
    !diamonds.every(value => Number.isSafeInteger(value) && value >= 0) ||
    fundedDiamonds !== budget || spentDiamonds + refundedDiamonds > fundedDiamonds ||
    fundedUsd !== 0 || spentUsd !== 0 || refundedUsd !== 0
  )) {
    fail(503, 'INVALID_DIAMOND_FUNDING', 'Campaign Diamond funding requires review')
  }
  const fundingType = hasDiamondFunding ? 'diamonds'
    : fundedUsd > 0 || spentUsd > 0 || refundedUsd > 0 ? 'usd' : 'unfunded'
  const availableDiamonds = fundedDiamonds - spentDiamonds - refundedDiamonds
  const paidUsd = fundedUsd - refundedUsd >= budget
  const spent = hasDiamondFunding ? spentDiamonds : spentUsd
  return {
    id: row.id,
    author_page_id: row.author_page_id,
    owner_user_id: row.owner_user_id,
    kind: row.campaign_kind,
    content_type: row.content_type,
    content_id: row.content_id,
    content_title: row.content_title,
    content_image_url: row.content_image_url,
    goal: row.goal,
    audience_mode: row.audience_mode,
    audience_filters: row.audience_filters || {},
    placements: row.placements || ['discover'],
    currency: hasDiamondFunding ? 'DIAMONDS' : 'USD',
    funding_type: fundingType,
    payment_status: hasDiamondFunding || paidUsd ? 'paid' : 'unpaid',
    budget_diamonds: fundingType === 'usd' ? 0 : budget,
    funded_diamonds: fundedDiamonds,
    spent_diamonds: spentDiamonds,
    refunded_diamonds: refundedDiamonds,
    remaining_diamonds: availableDiamonds,
    budget_usd: money(row.budget_cents),
    funded_usd: money(row.funded_cents),
    spent_usd: money(row.spent_cents),
    refunded_usd: money(row.refunded_cents),
    budget_used_percent: budget > 0 ? Math.round(spent / budget * 10000) / 100 : 0,
    duration_days: row.duration_days,
    status: row.status,
    review_status: row.review_status,
    review_reason: row.review_reason || '',
    reviewed_by: row.reviewed_by,
    reviewed_at: row.reviewed_at,
    submitted_at: row.submitted_at,
    start_at: row.start_at,
    end_at: row.end_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    payment_required: !hasDiamondFunding && !paidUsd,
    delivery_active: row.status === 'active',
  }
}

async function getDiamondFunding(rows) {
  const ids = [...new Set(rows.map(row => row.id).filter(Boolean))]
  if (!ids.length) return new Map()
  const { data, error } = await supabase.from('author_ad_diamond_funding')
    .select('campaign_id,owner_user_id,funded_diamonds,spent_diamonds,refunded_diamonds')
    .in('campaign_id', ids)
  if (error) throw error
  const funding = new Map()
  for (const row of data || []) {
    if (funding.has(row.campaign_id)) {
      fail(503, 'DUPLICATE_DIAMOND_FUNDING', 'Duplicate campaign funding found')
    }
    funding.set(row.campaign_id, row)
  }
  return funding
}

async function campaignById(id) {
  const { data, error } = await supabase.from('author_ad_campaigns')
    .select(CAMPAIGN_RETURN_COLUMNS)
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  if (!data) fail(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found')
  return data
}

async function getAuthorMaps(rows) {
  const pageIds = [...new Set(rows.map(row => row.author_page_id).filter(Boolean))]
  const userIds = [...new Set(rows.map(row => row.owner_user_id).filter(Boolean))]
  const [pagesResult, usersResult] = await Promise.all([
    pageIds.length
      ? supabase.from('author_pages')
          .select('id, page_name, page_username, avatar_url, status')
          .in('id', pageIds)
          .limit(MAX_PAGE_LIMIT)
      : Promise.resolve({ data: [], error: null }),
    userIds.length
      ? supabase.from('users')
          .select('id, name, username')
          .in('id', userIds)
          .limit(MAX_PAGE_LIMIT)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (pagesResult.error) throw pagesResult.error
  if (usersResult.error) throw usersResult.error
  return {
    pages: new Map((pagesResult.data || []).map(page => [String(page.id), page])),
    users: new Map((usersResult.data || []).map(user => [String(user.id), user])),
  }
}

function attachAuthor(row, maps, funding = null) {
  const author = maps.pages.get(String(row.author_page_id)) || null
  const user = maps.users.get(String(row.owner_user_id)) || null
  return {
    ...campaignResult(row, funding),
    author: {
      page_name: author?.page_name || 'Unknown Author',
      page_username: author?.page_username || '',
      avatar_url: author?.avatar_url || '',
      page_status: author?.status || 'unavailable',
      account_name: user?.name || user?.username || '',
    },
  }
}

function parseFilters(query = {}) {
  const kind = String(query.kind || 'all').trim().toLowerCase()
  const status = String(query.status || 'all').trim().toLowerCase()
  const sort = String(query.sort || 'newest').trim().toLowerCase()
  const page = Number(query.page || 1)
  const limit = Number(query.limit || 20)
  if (!['all', 'post', 'book'].includes(kind)) {
    fail(400, 'INVALID_KIND', 'Invalid Boost Post or Boost Book filter')
  }
  if (status !== 'all' && !STATUSES.has(status)) {
    fail(400, 'INVALID_STATUS', 'Invalid campaign status filter')
  }
  if (!['newest', 'top', 'low'].includes(sort)) {
    fail(400, 'INVALID_SORT', 'Invalid campaign sorting option')
  }
  if (!Number.isInteger(page) || !Number.isInteger(limit) ||
      page < 1 || page > 10000 || limit < 1 || limit > MAX_PAGE_LIMIT) {
    fail(400, 'INVALID_PAGINATION', 'Invalid pagination')
  }
  const authorPageId = String(query.author_page_id || '').trim()
  if (authorPageId && !UUID_PATTERN.test(authorPageId)) {
    fail(400, 'INVALID_AUTHOR', 'Invalid Author Page ID')
  }
  const search = String(query.search || '').trim().slice(0, 80)
  return { kind, status, sort, page, limit, authorPageId, search }
}

export async function listAdminAuthorAdCampaigns(req, res) {
  return respond(res, async () => {
    requireAdminIdentity(req)
    const filters = parseFilters(req.query)
    const { kind, status, sort, page, limit, authorPageId, search } = filters
    let query = supabase.from('author_ad_campaigns')
      .select(CAMPAIGN_RETURN_COLUMNS, { count: 'exact' })
    if (kind !== 'all') query = query.eq('campaign_kind', kind)
    if (status !== 'all') query = query.eq('status', status)
    if (authorPageId) query = query.eq('author_page_id', authorPageId)
    if (search) {
      if (UUID_PATTERN.test(search)) {
        query = query.eq('id', search)
      } else {
        const escaped = search.replace(/[\\%_]/g, '\\$&')
        query = query.ilike('content_title', `%${escaped}%`)
      }
    }
    if (sort !== 'newest') {
      query = query.order('spent_cents', { ascending: sort === 'low' })
    }
    const { data, count, error } = await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range((page - 1) * limit, page * limit - 1)
    if (error) throw error
    const [maps, funding] = await Promise.all([
      getAuthorMaps(data || []),
      getDiamondFunding(data || []),
    ])
    return res.json({
      ok: true,
      campaigns: (data || []).map(row => attachAuthor(row, maps, funding.get(row.id))),
      total: Number(count || 0),
      page,
      limit,
      sort,
      has_more: page * limit < Number(count || 0),
    })
  })
}

export async function getAdminAuthorAdSummary(req, res) {
  return respond(res, async () => {
    requireAdminIdentity(req)
    const filters = [
      ['total', null, null],
      ['boost_posts', 'campaign_kind', 'post'],
      ['boost_books', 'campaign_kind', 'book'],
      ['pending_review', 'status', 'pending_review'],
      ['approved', 'status', 'approved'],
      ['active', 'status', 'active'],
      ['completed', 'status', 'completed'],
    ]
    const [results, spendingResult] = await Promise.all([
      Promise.all(filters.map(([, field, value]) => {
        let query = supabase.from('author_ad_campaigns')
          .select('id', { count: 'exact', head: true })
        if (field) query = query.eq(field, value)
        return query
      })),
      supabase.rpc('get_admin_author_ad_money_totals_v1'),
    ])
    const summary = {}
    results.forEach((result, index) => {
      if (result.error) throw result.error
      summary[filters[index][0]] = Number(result.count || 0)
    })

    const emptySpending = () => ({
      campaigns_with_spend: 0,
      budget_usd: 0,
      funded_usd: 0,
      spent_usd: 0,
      refunded_usd: 0,
      remaining_funds_usd: 0,
    })
    const spending = {
      all: emptySpending(),
      post: emptySpending(),
      book: emptySpending(),
    }
    let spendingAvailable = false

    if (spendingResult.error) {
      console.error('ADMIN AUTHOR ADS SPENDING SUMMARY ERROR:', spendingResult.error)
    } else if (Array.isArray(spendingResult.data)) {
      try {
        if (!spendingResult.data.some((row) => row.campaign_kind === 'all')) {
          throw new Error('Spending summary total row is missing')
        }
        for (const row of spendingResult.data) {
          const kind = String(row.campaign_kind || '')
          if (!Object.prototype.hasOwnProperty.call(spending, kind)) continue
          const amounts = ['budget_cents', 'funded_cents', 'spent_cents', 'refunded_cents']
            .map((field) => Number(row[field]))
          if (amounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0)) {
            throw new Error('Spending summary amount is invalid')
          }
          const campaignsWithSpend = Number(row.campaigns_with_spend)
          if (!Number.isSafeInteger(campaignsWithSpend) || campaignsWithSpend < 0) {
            throw new Error('Spending campaign count is invalid')
          }
          const [budgetCents, fundedCents, spentCents, refundedCents] = amounts
          spending[kind] = {
            campaigns_with_spend: campaignsWithSpend,
            budget_usd: money(budgetCents),
            funded_usd: money(fundedCents),
            spent_usd: money(spentCents),
            refunded_usd: money(refundedCents),
            remaining_funds_usd: money(Math.max(0, fundedCents - spentCents - refundedCents)),
          }
        }
        spendingAvailable = true
      } catch (error) {
        console.error('ADMIN AUTHOR ADS SPENDING SUMMARY ERROR:', error)
      }
    }

    summary.spending = spendingAvailable ? spending : null
    summary.spending_available = spendingAvailable
    return res.json({ ok: true, summary })
  })
}

export async function getAdminAuthorAdCampaign(req, res) {
  return respond(res, async () => {
    requireAdminIdentity(req)
    const id = requireId(req.params.campaignId)
    const row = await campaignById(id)
    const [maps, funding, ...eventResults] = await Promise.all([
      getAuthorMaps([row]),
      getDiamondFunding([row]),
      ...EVENT_TYPES.map(eventType => supabase.from('author_ad_delivery_events')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', id)
        .eq('event_type', eventType)),
    ])
    const events = {}
    eventResults.forEach((result, index) => {
      if (result.error) throw result.error
      events[EVENT_TYPES[index]] = Number(result.count || 0)
    })
    const goalEvent = RESULT_EVENTS[row.goal] || null
    const impressions = events.impression
    const clicks = events.click
    const goalResults = goalEvent ? events[goalEvent] : null
    const diamondFunding = funding.get(row.id)
    let verifiedReach = null
    if (diamondFunding) {
      const { count, error } = await supabase.from('author_ad_delivery_events')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', id)
        .eq('event_type', 'impression')
        .like('event_key', 'diamond-reach:%')
      if (error) throw error
      verifiedReach = Number(count || 0)
    }
    return res.json({
      ok: true,
      campaign: attachAuthor(row, maps, diamondFunding),
      performance: {
        impressions,
        clicks,
        reading_starts: events.reading_start,
        follows: events.follow,
        unlocks: events.unlock,
        purchases: events.purchase,
        click_through_rate_percent: impressions > 0
          ? Math.round(clicks / impressions * 10000) / 100
          : 0,
        goal_results: goalResults,
        goal_event_type: goalEvent,
        conversion_rate_percent: goalEvent && clicks > 0
          ? Math.round(goalResults / clicks * 10000) / 100
          : null,
        unique_reach: verifiedReach,
        unique_reach_available: diamondFunding != null,
      },
    })
  })
}

async function ensureStillPublished(row) {
  const { data: author, error: authorError } = await supabase
    .from('author_pages')
    .select('id, status, user_id')
    .eq('id', row.author_page_id)
    .eq('user_id', row.owner_user_id)
    .eq('status', 'active')
    .maybeSingle()
  if (authorError) throw authorError
  if (!author) fail(409, 'AUTHOR_INACTIVE', 'Author Page is not active')

  let query
  if (row.content_type === 'post') {
    query = supabase.from('author_page_posts')
      .select('id, image_urls')
      .eq('id', row.content_id)
      .eq('author_page_id', author.id)
      .eq('user_id', row.owner_user_id)
      .eq('status', 'active')
  } else if (row.content_type === 'story') {
    query = supabase.from('stories')
      .select('id')
      .eq('id', row.content_id)
      .eq('author_id', author.id)
      .eq('status', 'published')
      .is('deleted_at', null)
  } else if (row.content_type === 'product') {
    query = supabase.from('author_store_products')
      .select('id')
      .eq('id', row.content_id)
      .eq('author_page_id', author.id)
      .eq('status', 'active')
      .in('product_type', ['book', 'pdf'])
  } else {
    fail(409, 'CONTENT_UNAVAILABLE', 'Unsupported content type')
  }
  const { data, error } = await query.maybeSingle()
  if (error) throw error
  if (!data) fail(409, 'CONTENT_UNAVAILABLE', 'Content is no longer published')
  if (row.content_type === 'post' &&
      !(Array.isArray(data.image_urls) && data.image_urls.some(url => typeof url === 'string' && url.trim()))) {
    fail(409, 'CONTENT_UNAVAILABLE', 'Photo post has no valid photos')
  }
}

export async function reviewAdminAuthorAdCampaign(req, res) {
  return respond(res, async () => {
    const admin = requireAdminIdentity(req)
    const id = requireId(req.params.campaignId)
    const action = String(req.body?.action || '').trim().toLowerCase()
    const reason = String(req.body?.reason || '').trim()
    if (!['approve', 'reject'].includes(action)) {
      fail(400, 'INVALID_ACTION', 'Choose approve or reject')
    }
    if (action === 'reject' && (reason.length < 5 || reason.length > 500)) {
      fail(400, 'INVALID_REJECTION_REASON', 'Rejection reason must be 5 to 500 characters')
    }
    if (action === 'approve' && reason.length > 500) {
      fail(400, 'INVALID_REVIEW_REASON', 'Review note cannot exceed 500 characters')
    }
    const current = await campaignById(id)
    if (current.status !== 'pending_review' || current.review_status !== 'pending') {
      fail(409, 'CAMPAIGN_NOT_PENDING', 'Only pending campaigns can be reviewed')
    }
    const currentFunding = await getDiamondFunding([current])
    if (action === 'reject' && (Number(current.funded_cents) !== 0 ||
        Number(current.spent_cents) !== 0 || Number(current.refunded_cents) !== 0 ||
        currentFunding.has(id))) {
      fail(409, 'REFUND_WORKFLOW_REQUIRED', 'Refund funded campaign before rejecting it')
    }
    if (action === 'approve') await ensureStillPublished(current)

    const adminId = String(admin.admin_id || admin.id || admin.user_id || '').trim()
    const now = new Date().toISOString()
    let query = supabase.from('author_ad_campaigns')
      .update({
        review_status: action === 'approve' ? 'approved' : 'rejected',
        status: action === 'approve' ? 'approved' : 'rejected',
        review_reason: reason || null,
        reviewed_by: UUID_PATTERN.test(adminId) ? adminId : null,
        reviewed_at: now,
      })
      .eq('id', id)
      .eq('status', 'pending_review')
      .eq('review_status', 'pending')
    if (action === 'reject') {
      query = query.eq('funded_cents', 0).eq('spent_cents', 0).eq('refunded_cents', 0)
    }
    const { data, error } = await query.select(CAMPAIGN_RETURN_COLUMNS).maybeSingle()
    if (error) throw error
    if (!data) fail(409, 'CAMPAIGN_CHANGED', 'Campaign changed; refresh before reviewing')
    console.info('ADMIN_AUTHOR_AD_REVIEW', JSON.stringify({
      campaign_id: id,
      action,
      actor: String(admin.admin_id || admin.id || admin.email || 'admin').slice(0, 120),
    }))
    const updatedFunding = await getDiamondFunding([data])
    const reviewed = campaignResult(data, updatedFunding.get(data.id))
    return res.json({
      ok: true,
      campaign: reviewed,
      delivery_active: false,
      payment_required: reviewed.payment_required,
    })
  })
}

