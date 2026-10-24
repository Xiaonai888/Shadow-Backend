import { supabase } from '../config/supabase.js'
import { verifyAuthorAdDiscoverReceipt } from '../services/authorAdDiscoverEngagement.service.js'
import { recordVerifiedAuthorAdDelivery } from '../services/authorAdDelivery.service.js'

const MAX_BODY_BYTES = 2048
const ALLOWED_FIELDS = new Set([
  'receipt', 'post_id', 'event_type', 'visible_ms', 'visible_ratio',
])

function invalidRequest(res) {
  return res.status(400).json({
    ok: false,
    code: 'INVALID_DISCOVER_BOOST_ENGAGEMENT',
    message: 'Invalid or expired Boost engagement receipt',
  })
}

function validateBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid Boost engagement request')
  }
  if (Object.keys(value).some(key => !ALLOWED_FIELDS.has(key))) {
    throw new TypeError('Unexpected Boost engagement fields')
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_BODY_BYTES) {
    throw new TypeError('Boost engagement request is too large')
  }
  if (value.event_type !== 'impression' && value.event_type !== 'click') {
    throw new TypeError('Unsupported Boost engagement event')
  }
  if (value.event_type === 'impression') {
    if (
      !Number.isSafeInteger(value.visible_ms) ||
      value.visible_ms < 1000 ||
      value.visible_ms > 120000 ||
      typeof value.visible_ratio !== 'number' ||
      !Number.isFinite(value.visible_ratio) ||
      value.visible_ratio < 0.5 ||
      value.visible_ratio > 1
    ) {
      throw new TypeError('Invalid reported ad visibility')
    }
  } else if (value.visible_ms !== undefined || value.visible_ratio !== undefined) {
    throw new TypeError('Unexpected click visibility fields')
  }
  return value
}

function eligibleCampaign(campaign, proof) {
  if (!campaign) return false
  const budget = Number(campaign.budget_cents)
  const funded = Number(campaign.funded_cents)
  const refunded = Number(campaign.refunded_cents)
  const spent = Number(campaign.spent_cents)
  const now = Date.now()
  const start = new Date(campaign.start_at || 0).getTime()
  const end = new Date(campaign.end_at || 0).getTime()

  return campaign.id === proof.campaignId &&
    campaign.owner_user_id !== proof.viewerUserId &&
    campaign.author_page_id === proof.authorPageId &&
    campaign.content_id === proof.postId &&
    campaign.campaign_kind === 'post' &&
    campaign.content_type === 'post' &&
    campaign.currency === 'USD' &&
    campaign.status === 'active' &&
    campaign.review_status === 'approved' &&
    Boolean(campaign.reviewed_at) &&
    Array.isArray(campaign.placements) &&
    campaign.placements.includes('discover') &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start <= now &&
    now < end &&
    [budget, funded, refunded, spent].every(value =>
      Number.isSafeInteger(value) && value >= 0
    ) &&
    budget > spent &&
    funded - refunded >= budget &&
    funded - refunded - spent > 0
}

async function assertCurrentEligibility(proof) {
  const campaignResult = await supabase.from('author_ad_campaigns')
    .select('id,owner_user_id,author_page_id,content_id,campaign_kind,content_type,currency,status,review_status,reviewed_at,placements,start_at,end_at,budget_cents,funded_cents,refunded_cents,spent_cents')
    .eq('id', proof.campaignId).maybeSingle()

  if (campaignResult.error) throw campaignResult.error
  const campaign = campaignResult.data
  if (!eligibleCampaign(campaign, proof)) {
    const error = new Error('Boost campaign is no longer eligible')
    error.code = 'BOOST_CAMPAIGN_NOT_ELIGIBLE'
    throw error
  }

  const [
    postResult,
    pageResult,
    pageBlockResult,
    accountBlockResult,
  ] = await Promise.all([
    supabase.from('author_page_posts')
      .select('id,author_page_id,user_id,image_urls')
      .eq('id', proof.postId).eq('status', 'active').maybeSingle(),
    supabase.from('author_pages')
      .select('id,user_id')
      .eq('id', proof.authorPageId).eq('status', 'active').maybeSingle(),
    supabase.from('reader_blocked_author_pages')
      .select('author_page_id')
      .eq('reader_user_id', proof.viewerUserId)
      .eq('author_page_id', proof.authorPageId).limit(1),
    supabase.from('chat_blocks')
      .select('blocked_user_id')
      .eq('blocker_user_id', proof.viewerUserId)
      .eq('blocked_user_id', campaign.owner_user_id).limit(1),
  ])

  for (const result of [
    postResult,
    pageResult,
    pageBlockResult,
    accountBlockResult,
  ]) {
    if (result.error) throw result.error
  }

  const post = postResult.data
  const page = pageResult.data

  if (
    !page ||
    page.user_id !== campaign.owner_user_id ||
    !post ||
    post.author_page_id !== page.id ||
    post.user_id !== page.user_id ||
    !Array.isArray(post.image_urls) ||
    !post.image_urls.some(value => typeof value === 'string' && value.trim()) ||
    (pageBlockResult.data || []).length ||
    (accountBlockResult.data || []).length
  ) {
    const error = new Error('Boost campaign is no longer eligible')
    error.code = 'BOOST_CAMPAIGN_NOT_ELIGIBLE'
    throw error
  }
}

export async function recordAuthorAdDiscoverEngagement(req, res) {
  if (process.env.AUTHOR_ADS_DELIVERY_ENABLED !== 'true') {
    return res.status(503).json({
      ok: false,
      code: 'AUTHOR_ADS_DELIVERY_DISABLED',
      message: 'Boost delivery is not available yet',
    })
  }

  const viewerUserId = req.user?.user_id
  if (!viewerUserId) {
    return res.status(401).json({
      ok: false,
      code: 'AUTH_REQUIRED',
      message: 'Reader login required',
    })
  }

  let body
  let proof
  try {
    body = validateBody(req.body)
    proof = verifyAuthorAdDiscoverReceipt({
      token: body.receipt,
      viewerUserId,
      postId: body.post_id,
      eventType: body.event_type,
    })
  } catch (error) {
    if (error.code === 'AUTHOR_ADS_DELIVERY_DISABLED') {
      return res.status(503).json({
        ok: false,
        code: error.code,
        message: 'Boost delivery is not available yet',
      })
    }
    return invalidRequest(res)
  }

  try {
    await assertCurrentEligibility(proof)

    const event = await recordVerifiedAuthorAdDelivery({
      campaignId: proof.campaignId,
      viewerUserId: proof.viewerUserId,
      verifiedActionId: proof.verifiedActionId,
      eventType: proof.eventType,
      chargeCents: 0,
      metadata: {
        placement: 'discover',
        author_page_id: proof.authorPageId,
        post_id: proof.postId,
        measurement: 'client_reported',
        ...(body.event_type === 'impression'
          ? {
              reported_visible_ms: body.visible_ms,
              reported_visible_ratio: body.visible_ratio,
            }
          : {}),
      },
    })

    return res.status(200).json({
      ok: true,
      recorded: event.recorded,
      event_type: proof.eventType,
    })
  } catch (error) {
    if (error.code === 'BOOST_CAMPAIGN_NOT_ELIGIBLE' || error.code === 'P0001') {
      return res.status(409).json({
        ok: false,
        code: 'BOOST_CAMPAIGN_NOT_ELIGIBLE',
        message: 'This Boost campaign is no longer available',
      })
    }
    if (error.code === 'AUTHOR_AD_DELIVERY_SQL_REQUIRED') {
      return res.status(503).json({
        ok: false,
        code: error.code,
        message: 'Boost delivery is not configured',
      })
    }

    console.error('DISCOVER BOOST ENGAGEMENT ERROR:', error)
    return res.status(500).json({
      ok: false,
      code: 'BOOST_ENGAGEMENT_FAILED',
      message: 'Could not record Boost engagement',
    })
  }
}
