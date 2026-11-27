import { supabase } from '../../config/supabase.js'
import { getPublicAuthorPreOrder } from '../authorPreOrderPublicCatalog.service.js'
import { createShadowAiPreOrderContext } from './shadowAiPreOrderContext.service.js'
import { shadowAiError } from './shadowAiPolicy.js'

async function listCampaigns(authorPageId, { offset, limit, time }) {
  const timestamp = new Date(time).toISOString()
  const { data, error } = await supabase.from('author_preorder_campaigns')
    .select('id,author_page_id,title,status,published_at,open_at,close_at,author:author_pages!inner(status),books:author_preorder_books(id,title,position)')
    .eq('author_page_id', authorPageId)
    .eq('author.status', 'active')
    .eq('status', 'active')
    .not('published_at', 'is', null)
    .lte('open_at', timestamp)
    .gt('close_at', timestamp)
    .order('published_at', { ascending: false })
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1)
    .abortSignal(AbortSignal.timeout(5000))
  if (error || !Array.isArray(data)) throw shadowAiError('SHADOW_AI_CONTEXT_UNAVAILABLE', 'Pre-order context is unavailable')
  return data
}

async function getCampaign(campaignId) {
  try { return await getPublicAuthorPreOrder(campaignId) }
  catch (error) {
    if (error?.code === 'PRE_ORDER_READER_NOT_FOUND') throw shadowAiError('SHADOW_AI_CAMPAIGN_UNAVAILABLE', 'This pre-order is not available', 409)
    throw shadowAiError('SHADOW_AI_CONTEXT_UNAVAILABLE', 'Pre-order context is unavailable')
  }
}

export const shadowAiPreOrderContext = createShadowAiPreOrderContext({ listCampaigns, getCampaign })
