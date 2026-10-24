import { supabase } from '../config/supabase.js'
import {
  verifyAuthorAdDiscoverReceipt,
  verifyAuthorAdDiscoverBookReceipt,
} from '../services/authorAdDiscoverEngagement.service.js'
import { recordVerifiedAuthorAdDelivery } from '../services/authorAdDelivery.service.js'
import { recordVerifiedAuthorAdDiamondReach } from '../services/authorAdDiamondDelivery.service.js'

const MAX_BODY_BYTES = 2048
const POST_FIELDS = new Set(['receipt', 'post_id', 'event_type', 'visible_ms', 'visible_ratio'])
const BOOK_FIELDS = new Set(['receipt', 'content_id', 'content_type', 'event_type', 'visible_ms', 'visible_ratio'])

function responseError(res, status, code, message) {
  return res.status(status).json({ ok: false, code, message })
}

function invalidRequest(res) {
  return responseError(res, 400, 'INVALID_DISCOVER_BOOST_ENGAGEMENT', 'Invalid or expired Boost engagement receipt')
}

function validateBody(value, kind) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid Boost engagement request')
  }
  const fields = kind === 'book' ? BOOK_FIELDS : POST_FIELDS
  if (Object.keys(value).some(key => !fields.has(key))) {
    throw new TypeError('Unexpected Boost engagement fields')
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_BODY_BYTES) {
    throw new TypeError('Boost engagement request is too large')
  }
  if (value.event_type !== 'impression' && value.event_type !== 'click') {
    throw new TypeError('Unsupported Boost engagement event')
  }
  if (value.event_type === 'impression') {
    if (!Number.isSafeInteger(value.visible_ms) || value.visible_ms < 1000 || value.visible_ms > 120000
      || typeof value.visible_ratio !== 'number' || !Number.isFinite(value.visible_ratio)
      || value.visible_ratio < 0.5 || value.visible_ratio > 1) {
      throw new TypeError('Invalid reported ad visibility')
    }
  } else if (value.visible_ms !== undefined || value.visible_ratio !== undefined) {
    throw new TypeError('Unexpected click visibility fields')
  }
  return value
}

function eligibleCampaign(campaign, proof, kind) {
  if (!campaign) return false
  const now = Date.now()
  const start = new Date(campaign.start_at || 0).getTime()
  const end = new Date(campaign.end_at || 0).getTime()
  return campaign.id === proof.campaignId &&
    campaign.owner_user_id !== proof.viewerUserId &&
    campaign.author_page_id === proof.authorPageId &&
    campaign.content_id === (kind === 'post' ? proof.postId : proof.contentId) &&
    campaign.campaign_kind === kind &&
    campaign.content_type === (kind === 'post' ? 'post' : proof.contentType) &&
    campaign.currency === 'USD' &&
    campaign.status === 'active' &&
    campaign.review_status === 'approved' &&
    Boolean(campaign.reviewed_at) &&
    Array.isArray(campaign.placements) &&
    campaign.placements.includes('discover') &&
    Number.isFinite(start) && Number.isFinite(end) && start <= now && now < end
}

function eligibleFunding(campaign, funding) {
  const money = [campaign.budget_cents, campaign.funded_cents, campaign.refunded_cents, campaign.spent_cents].map(Number)
  if (!money.every(value => Number.isSafeInteger(value) && value >= 0)) return false
  const [budget, funded, refunded, spent] = money
  if (funding) {
    const diamonds = [funding.funded_diamonds, funding.spent_diamonds, funding.refunded_diamonds].map(Number)
    if (!diamonds.every(value => Number.isSafeInteger(value) && value >= 0)) return false
    const [fundedDiamonds, spentDiamonds, refundedDiamonds] = diamonds
    return funding.owner_user_id === campaign.owner_user_id &&
      budget > 0 && fundedDiamonds === budget &&
      funded === 0 && refunded === 0 && spent === 0 &&
      spentDiamonds + refundedDiamonds < fundedDiamonds
  }
  return budget > spent && funded - refunded >= budget && funded - refunded - spent > 0
}

async function assertCurrentEligibility(proof, kind) {
  const campaignResult = await supabase.from('author_ad_campaigns')
    .select('id,owner_user_id,author_page_id,content_id,campaign_kind,content_type,currency,status,review_status,reviewed_at,placements,start_at,end_at,budget_cents,funded_cents,refunded_cents,spent_cents')
    .eq('id', proof.campaignId).maybeSingle()
  if (campaignResult.error) throw campaignResult.error
  const campaign = campaignResult.data
  if (!eligibleCampaign(campaign, proof, kind)) {
    const error = new Error('Boost campaign is no longer eligible')
    error.code = 'BOOST_CAMPAIGN_NOT_ELIGIBLE'
    throw error
  }

  const fundingResult = await supabase.from('author_ad_diamond_funding')
    .select('owner_user_id,funded_diamonds,spent_diamonds,refunded_diamonds')
    .eq('campaign_id', campaign.id).maybeSingle()
  const missingFundingTable = ['42P01', 'PGRST205'].includes(fundingResult.error?.code)
  if (fundingResult.error && !missingFundingTable) throw fundingResult.error
  const funding = missingFundingTable ? null : fundingResult.data
  if (!eligibleFunding(campaign, funding)) {
    const error = new Error('Boost campaign is no longer funded')
    error.code = 'BOOST_CAMPAIGN_NOT_ELIGIBLE'
    throw error
  }

  const contentQuery = kind === 'post'
    ? supabase.from('author_page_posts').select('id,author_page_id,user_id,image_urls')
      .eq('id', proof.postId).eq('status', 'active').maybeSingle()
    : proof.contentType === 'story'
      ? supabase.from('stories').select('id,author_id,cover_url')
        .eq('id', proof.contentId).eq('status', 'published').is('deleted_at', null).maybeSingle()
      : supabase.from('author_store_products').select('id,author_page_id,cover_url,product_type')
        .eq('id', proof.contentId).eq('status', 'active').in('product_type', ['book', 'pdf']).maybeSingle()

  const [contentResult, pageResult, pageBlockResult, accountBlockResult] = await Promise.all([
    contentQuery,
    supabase.from('author_pages').select('id,user_id')
      .eq('id', proof.authorPageId).eq('status', 'active').maybeSingle(),
    supabase.from('reader_blocked_author_pages').select('author_page_id')
      .eq('reader_user_id', proof.viewerUserId).eq('author_page_id', proof.authorPageId).limit(1),
    supabase.from('chat_blocks').select('blocked_user_id')
      .eq('blocker_user_id', proof.viewerUserId).eq('blocked_user_id', campaign.owner_user_id).limit(1),
  ])
  for (const result of [contentResult, pageResult, pageBlockResult, accountBlockResult]) {
    if (result.error) throw result.error
  }

  const content = contentResult.data
  const page = pageResult.data
  const validContent = kind === 'post'
    ? content?.author_page_id === page?.id && content?.user_id === page?.user_id &&
      Array.isArray(content?.image_urls) &&
      content.image_urls.some(value => typeof value === 'string' && value.trim())
    : proof.contentType === 'story'
      ? content?.author_id === page?.id && typeof content?.cover_url === 'string' && Boolean(content.cover_url.trim())
      : content?.author_page_id === page?.id && typeof content?.cover_url === 'string' && Boolean(content.cover_url.trim())

  if (!page || page.user_id !== campaign.owner_user_id || !content || !validContent
    || (pageBlockResult.data || []).length || (accountBlockResult.data || []).length) {
    const error = new Error('Boost campaign is no longer eligible')
    error.code = 'BOOST_CAMPAIGN_NOT_ELIGIBLE'
    throw error
  }
  return { billing: funding ? 'diamonds' : 'usd' }
}

async function recordEngagement(req, res, kind) {
  if (process.env.AUTHOR_ADS_DELIVERY_ENABLED !== 'true') {
    return responseError(res, 503, 'AUTHOR_ADS_DELIVERY_DISABLED', 'Boost delivery is not available yet')
  }
  if (kind === 'book' && process.env.AUTHOR_ADS_BOOK_DELIVERY_ENABLED !== 'true') {
    return responseError(res, 503, 'AUTHOR_ADS_BOOK_DELIVERY_DISABLED', 'Book Boost delivery is not available yet')
  }
  const viewerUserId = req.user?.user_id
  if (!viewerUserId) {
    return responseError(res, 401, 'AUTH_REQUIRED', 'Reader login required')
  }

  let body
  let proof
  try {
    body = validateBody(req.body, kind)
    proof = kind === 'post'
      ? verifyAuthorAdDiscoverReceipt({
        token: body.receipt, viewerUserId, postId: body.post_id, eventType: body.event_type,
      })
      : verifyAuthorAdDiscoverBookReceipt({
        token: body.receipt, viewerUserId, contentId: body.content_id,
        contentType: body.content_type, eventType: body.event_type,
      })
  } catch (error) {
    if (error.code === 'AUTHOR_ADS_DELIVERY_DISABLED' || error.code === 'AUTHOR_ADS_BOOK_DELIVERY_DISABLED') {
      return responseError(res, 503, error.code, 'Boost delivery is not available yet')
    }
    return invalidRequest(res)
  }

  try {
    const { billing } = await assertCurrentEligibility(proof, kind)
    if (billing === 'diamonds' && proof.eventType === 'click') {
      return responseError(res, 503, 'AUTHOR_AD_DIAMOND_CLICK_NOT_READY', 'Diamond Boost click tracking is not available yet')
    }

    const event = billing === 'diamonds'
      ? await recordVerifiedAuthorAdDiamondReach({
        campaignId: proof.campaignId,
        viewerUserId: proof.viewerUserId,
        verifiedActionId: proof.verifiedActionId,
        contentType: kind === 'post' ? 'post' : proof.contentType,
        visibleMs: body.visible_ms,
        visibleRatio: body.visible_ratio,
      })
      : await recordVerifiedAuthorAdDelivery({
        campaignId: proof.campaignId,
        viewerUserId: proof.viewerUserId,
        verifiedActionId: proof.verifiedActionId,
        eventType: proof.eventType,
        chargeCents: 0,
        metadata: {
          placement: 'discover',
          author_page_id: proof.authorPageId,
          ...(kind === 'post' ? { post_id: proof.postId } : {
            content_id: proof.contentId, content_type: proof.contentType,
          }),
          measurement: 'client_reported',
          ...(body.event_type === 'impression' ? {
            reported_visible_ms: body.visible_ms,
            reported_visible_ratio: body.visible_ratio,
          } : {}),
        },
      })

    return res.status(200).json({
      ok: true,
      recorded: event.recorded,
      event_type: proof.eventType,
    })
  } catch (error) {
    if (error.code === 'BOOST_CAMPAIGN_NOT_ELIGIBLE' || error.code === 'P0001'
      || error.publicCode === 'AUTHOR_AD_DIAMOND_REACH_DENIED') {
      return responseError(res, 409, 'BOOST_CAMPAIGN_NOT_ELIGIBLE', 'This Boost campaign is no longer available')
    }
    if (error.code === 'AUTHOR_AD_DELIVERY_SQL_REQUIRED'
      || error.publicCode === 'AUTHOR_AD_DIAMOND_REACH_SQL_REQUIRED'
      || error.publicCode === 'AUTHOR_ADS_DELIVERY_DISABLED'
      || error.publicCode === 'AUTHOR_ADS_BOOK_DELIVERY_DISABLED') {
      return responseError(res, 503, error.publicCode || error.code, 'Boost delivery is not configured')
    }
    console.error('DISCOVER BOOST ENGAGEMENT ERROR:', error)
    return responseError(res, 500, 'BOOST_ENGAGEMENT_FAILED', 'Could not record Boost engagement')
  }
}

export async function recordAuthorAdDiscoverEngagement(req, res) {
  return recordEngagement(req, res, 'post')
}

export async function recordAuthorAdDiscoverBookEngagement(req, res) {
  return recordEngagement(req, res, 'book')
}
