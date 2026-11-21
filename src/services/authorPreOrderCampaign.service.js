import { supabase } from '../config/supabase.js'
import { readReaderClassificationCountry } from './readerClassificationCountrySource.service.js'
import { preOrderError, preOrderUuid, parseAuthorPreOrderDraft, parseAuthorPreOrderListQuery } from './authorPreOrderValidation.service.js'

const CAMPAIGNS = 'author_preorder_campaigns'
const BOOKS = 'author_preorder_books'

function databaseFailure(error, label) {
  if (!error) return
  if (error.code === '42P01' || error.code === '42883') {
    throw preOrderError('PRE_ORDER_NOT_READY', 'Pre-order database has not been installed yet', 503)
  }
  if (error.message?.includes('PRE_ORDER_NOT_EDITABLE')) {
    throw preOrderError('PRE_ORDER_NOT_EDITABLE', 'Only draft campaigns may be edited', 409)
  }
  if (error.message?.includes('PRE_ORDER_NOT_FOUND')) {
    throw preOrderError('PRE_ORDER_NOT_FOUND', 'Pre-order campaign was not found', 404)
  }
  if (error.message?.includes('PRE_ORDER_NOT_OWNER')) {
    throw preOrderError('PRE_ORDER_NOT_OWNER', 'Pre-order campaign access denied', 403)
  }
  console.error(`AUTHOR_PRE_ORDER_${label}:`, String(error.message || error))
  throw preOrderError('PRE_ORDER_STORAGE_UNAVAILABLE', 'Pre-order database is temporarily unavailable', 503)
}

export async function requireCambodianAuthorPreOrderOwner(userId) {
  const ownerId = preOrderUuid(userId, 'user ID')
  let classification
  try {
    classification = await readReaderClassificationCountry(ownerId)
  } catch (error) {
    console.error('AUTHOR_PRE_ORDER_COUNTRY_ERROR:', String(error.message || error))
    throw preOrderError('PRE_ORDER_COUNTRY_UNAVAILABLE', 'Could not verify your country', 503)
  }
  if (!classification?.verified || classification.country !== 'KH') {
    throw preOrderError('PRE_ORDER_COUNTRY_DENIED', 'Verified Cambodian authors only', 403)
  }
  const { data, error } = await supabase
    .from('author_pages')
    .select('id')
    .eq('user_id', ownerId)
    .eq('status', 'active')
    .maybeSingle()
  databaseFailure(error, 'OWNER')
  if (!data?.id) throw preOrderError('PRE_ORDER_AUTHOR_REQUIRED', 'An active author page is required', 403)
  return { authorPageId: data.id, userId: ownerId }
}

function apiBook(row) {
  return {
    id: row.id,
    title: row.title,
    cover_url: row.cover_url,
    editions: {
      standard: {
        enabled: row.standard_enabled === true,
        price_usd: Number(row.standard_price_usd || 0),
        quota: Number(row.standard_quota || 0),
        reserved: Number(row.standard_reserved || 0),
      },
      limited: {
        enabled: row.limited_enabled === true,
        price_usd: Number(row.limited_price_usd || 0),
        quota: Number(row.limited_quota || 0),
        reserved: Number(row.limited_reserved || 0),
      },
    },
  }
}

function apiCampaign(campaign, books) {
  return {
    ...campaign,
    signature_fee_usd: Number(campaign.signature_fee_usd || 0),
    total_orders: Number(campaign.total_orders || 0),
    delivery_company_keys: Array.isArray(campaign.delivery_company_keys) ? campaign.delivery_company_keys : [],
    books: (books || []).map(apiBook),
  }
}

async function hydrateCampaigns(campaigns) {
  if (!Array.isArray(campaigns) || !campaigns.length) return []
  const ids = campaigns.map(item => item.id)
  const { data: books, error } = await supabase
    .from(BOOKS)
    .select('id,campaign_id,position,title,cover_url,standard_enabled,standard_price_usd,standard_quota,standard_reserved,limited_enabled,limited_price_usd,limited_quota,limited_reserved')
    .in('campaign_id', ids)
    .order('position', { ascending: true })
  databaseFailure(error, 'BOOKS')
  const byCampaign = new Map(ids.map(id => [id, []]))
  for (const book of books || []) byCampaign.get(book.campaign_id)?.push(book)
  return campaigns.map(row => apiCampaign(row, byCampaign.get(row.id) || []))
}

export async function listOwnedAuthorPreOrders(owner, query) {
  const { status, page, limit, search } = parseAuthorPreOrderListQuery(query)
  const offset = (page - 1) * limit
  let request = supabase.from(CAMPAIGNS)
    .select('*', { count: 'exact' })
    .eq('author_page_id', owner.authorPageId)
    .eq('owner_user_id', owner.userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)
  if (status !== 'all') request = request.eq('status', status)
  if (search) request = request.ilike('title', `%${search.replace(/[%,_]/g, '')}%`)
  const [results, summaryResults] = await Promise.all([
    request,
    supabase.rpc('author_preorder_summary', {
      p_author_page_id: owner.authorPageId,
      p_owner_user_id: owner.userId,
    }),
  ])
  databaseFailure(results.error, 'LIST')
  databaseFailure(summaryResults.error, 'SUMMARY')
  const items = await hydrateCampaigns(results.data || [])
  const count = Number(results.count || 0)
  return {
    campaigns: items,
    total: count,
    has_more: offset + items.length < count,
    summary: summaryResults.data || null,
  }
}

export async function getOwnedAuthorPreOrder(owner, campaignId) {
  const id = preOrderUuid(campaignId, 'campaign ID')
  const { data, error } = await supabase.from(CAMPAIGNS)
    .select('*')
    .eq('id', id)
    .eq('author_page_id', owner.authorPageId)
    .eq('owner_user_id', owner.userId)
    .maybeSingle()
  databaseFailure(error, 'DETAIL')
  if (!data) throw preOrderError('PRE_ORDER_NOT_FOUND', 'Pre-order campaign was not found', 404)
  const [campaign] = await hydrateCampaigns([data])
  return campaign
}

export async function saveOwnedAuthorPreOrderDraft(owner, input, campaignId = null) {
  const payload = parseAuthorPreOrderDraft(input)
  const id = campaignId ? preOrderUuid(campaignId, 'campaign ID') : null
  const { data, error } = await supabase.rpc('author_preorder_save_draft', {
    p_author_page_id: owner.authorPageId,
    p_owner_user_id: owner.userId,
    p_campaign_id: id,
    p_payload: payload,
  })
  databaseFailure(error, 'SAVE_DRAFT')
  if (!data) throw preOrderError('PRE_ORDER_SAVE_FAILED', 'Draft was not saved', 503)
  return getOwnedAuthorPreOrder(owner, data)
}
