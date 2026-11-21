import { supabase } from '../config/supabase.js'
import { getAuthorCheckoutDeliverySettings } from '../controllers/authorStore.controller.js'
import { preOrderError } from './authorPreOrderValidation.service.js'
import { parsePublicPreOrderListQuery, preOrderUuid } from './authorPreOrderReaderValidation.service.js'

const AUTHOR = 'author:author_pages!inner(id,page_name,page_username,status)'
const CAMPAIGN_FIELDS = [
  'id', 'author_page_id', 'title', 'description', 'genre', 'banner_url',
  'open_at', 'close_at', 'expected_ship_at', 'status', 'published_at',
  'signature_enabled', 'signature_fee_usd', 'signature_note',
  'delivery_company_keys', 'delivery_note', 'buyer_note_instruction', AUTHOR,
].join(',')
const BOOK_FIELDS = [
  'id', 'campaign_id', 'position', 'title', 'cover_url',
  'standard_enabled', 'standard_price_usd', 'standard_quota', 'standard_reserved',
  'limited_enabled', 'limited_price_usd', 'limited_quota', 'limited_reserved',
].join(',')

function storageError(error, scope) {
  if (!error) return
  console.error(`PRE_ORDER_READER_${scope}_STORAGE:`, String(error.message || error))
  throw preOrderError('PRE_ORDER_READER_STORAGE_UNAVAILABLE', 'Pre-order information is temporarily unavailable', 503)
}

function readableBook(book) {
  return {
    id: book.id,
    title: book.title,
    cover_url: book.cover_url,
    editions: {
      standard: {
        enabled: book.standard_enabled === true,
        price_usd: Number(book.standard_price_usd),
        quota: Number(book.standard_quota),
        available: Math.max(0, Number(book.standard_quota) - Number(book.standard_reserved)),
      },
      limited: {
        enabled: book.limited_enabled === true,
        price_usd: Number(book.limited_price_usd),
        quota: Number(book.limited_quota),
        available: Math.max(0, Number(book.limited_quota) - Number(book.limited_reserved)),
      },
    },
  }
}

function readableCampaign(row, book) {
  return {
    id: row.id,
    author_page_id: row.author_page_id,
    author: { page_name: row.author?.page_name || '', page_username: row.author?.page_username || '' },
    title: row.title,
    description: row.description,
    genre: row.genre,
    banner_url: row.banner_url,
    open_at: row.open_at,
    close_at: row.close_at,
    expected_ship_at: row.expected_ship_at,
    status: row.status,
    signature_enabled: row.signature_enabled === true,
    signature_fee_usd: Number(row.signature_fee_usd || 0),
    signature_note: row.signature_note,
    delivery_note: row.delivery_note,
    buyer_note_instruction: row.buyer_note_instruction,
    book: readableBook(book),
  }
}

async function getBooks(campaignIds) {
  if (!campaignIds.length) return new Map()
  const { data, error } = await supabase.from('author_preorder_books')
    .select(BOOK_FIELDS)
    .in('campaign_id', campaignIds)
    .order('position', { ascending: true })
  storageError(error, 'BOOKS')
  const booksByCampaign = new Map()
  for (const row of data || []) {
    const list = booksByCampaign.get(row.campaign_id) || []
    list.push(row)
    booksByCampaign.set(row.campaign_id, list)
  }
  return booksByCampaign
}

export async function listPublicAuthorPreOrders(rawQuery = {}) {
  const { page, limit, status, search } = parsePublicPreOrderListQuery(rawQuery)
  const offset = (page - 1) * limit
  let query = supabase.from('author_preorder_campaigns')
    .select(CAMPAIGN_FIELDS, { count: 'exact' })
    .in('status', status === 'all' ? ['scheduled', 'active'] : [status])
    .not('published_at', 'is', null)
    .eq('author.status', 'active')
    .order('published_at', { ascending: false })
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1)
  if (search) query = query.ilike('title', `%${search.replace(/[\\%_,]/g, '')}%`)
  const { data, error, count } = await query
  storageError(error, 'LIST')
  const booksByCampaign = await getBooks((data || []).map(row => row.id))
  const records = (data || [])
    .filter(row => (booksByCampaign.get(row.id) || []).length === 1)
    .map(row => readableCampaign(row, booksByCampaign.get(row.id)[0]))
  return {
    records,
    page,
    limit,
    total: Number(count || 0),
    has_more: offset + (data || []).length < Number(count || 0),
  }
}

export async function getPublicAuthorPreOrder(campaignId, { includeDelivery = true } = {}) {
  const id = preOrderUuid(campaignId, 'pre-order record ID')
  const { data, error } = await supabase.from('author_preorder_campaigns')
    .select(CAMPAIGN_FIELDS)
    .eq('id', id)
    .in('status', ['scheduled', 'active'])
    .not('published_at', 'is', null)
    .eq('author.status', 'active')
    .maybeSingle()
  storageError(error, 'DETAIL')
  if (!data) throw preOrderError('PRE_ORDER_READER_NOT_FOUND', 'Pre-order is not available', 404)
  const booksByCampaign = await getBooks([id])
  const books = booksByCampaign.get(id) || []
  if (books.length !== 1) {
    throw preOrderError('PRE_ORDER_READER_UNAVAILABLE', 'Pre-order requires one story per master record', 503)
  }
  const record = readableCampaign(data, books[0])
  if (!includeDelivery) return record
  let settings
  try {
    settings = await getAuthorCheckoutDeliverySettings(record.author_page_id)
  } catch (error) {
    console.error('PRE_ORDER_READER_DELIVERY_STORAGE:', String(error.message || error))
    throw preOrderError('PRE_ORDER_READER_DELIVERY_UNAVAILABLE', 'Delivery settings are temporarily unavailable', 503)
  }
  const allowed = new Set(Array.isArray(data.delivery_company_keys) ? data.delivery_company_keys : [])
  record.delivery_companies = (settings || [])
    .filter(company => company?.is_active !== false && allowed.has(company.company_key))
    .map(company => ({
      company_key: company.company_key,
      company_name: company.company_name,
      fee_usd: Number(company.fee_usd),
      logo_url: company.logo_url || '',
    }))
  return record
}
