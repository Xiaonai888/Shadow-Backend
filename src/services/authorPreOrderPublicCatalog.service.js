import { supabase } from '../config/supabase.js'
import { getAuthorCheckoutDeliverySettings } from '../controllers/authorStore.controller.js'
import { preOrderError } from './authorPreOrderValidation.service.js'
import { parsePublicPreOrderListQuery, preOrderUuid } from './authorPreOrderReaderValidation.service.js'
import { getAuthorPreOrderPaymentAvailability } from './authorPreOrderPaymentAvailability.service.js'

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
const MAX_VOLUMES = 10
const MISSING_RPC = new Set(['PGRST202', '42883'])

function storageError(error, scope) {
  if (!error) return
  console.error(`PRE_ORDER_READER_${scope}_STORAGE:`, String(error.code || 'unknown'))
  throw preOrderError('PRE_ORDER_READER_STORAGE_UNAVAILABLE', 'Pre-order information is temporarily unavailable', 503)
}

function money(value, field) {
  const text = String(value ?? '').trim()
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(text)) {
    throw preOrderError('PRE_ORDER_READER_PRICE_INVALID', `Invalid stored ${field}`, 503)
  }
  const amount = Number(text)
  if (!Number.isFinite(amount) || amount < 0) {
    throw preOrderError('PRE_ORDER_READER_PRICE_INVALID', `Invalid stored ${field}`, 503)
  }
  return amount
}

function inventoryNumber(value, field) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) {
    throw preOrderError('PRE_ORDER_READER_STOCK_INVALID', `Invalid stored ${field}`, 503)
  }
  return number
}

function readableEdition(book, kind, snapshot) {
  const enabled = book[`${kind}_enabled`] === true
  const price = money(book[`${kind}_price_usd`], `${kind} price`)
  const quota = inventoryNumber(book[`${kind}_quota`], `${kind} quota`)
  const paidReserved = inventoryNumber(book[`${kind}_reserved`], `${kind} paid stock`)
  if (paidReserved > quota) {
    throw preOrderError('PRE_ORDER_READER_STOCK_INVALID', 'Paid stock exceeds pre-order quota', 503)
  }

  let pendingHeld = 0
  if (snapshot) {
    const edition = snapshot[kind]
    pendingHeld = inventoryNumber(edition?.payment_pending_held, `${kind} held stock`)
    if (edition?.enabled !== enabled ||
        inventoryNumber(edition?.quota, `${kind} snapshot quota`) !== quota ||
        inventoryNumber(edition?.paid_reserved, `${kind} snapshot paid stock`) !== paidReserved ||
        paidReserved + pendingHeld > quota ||
        inventoryNumber(edition?.available, `${kind} snapshot availability`) !==
          (enabled ? quota - paidReserved - pendingHeld : 0)) {
      throw preOrderError('PRE_ORDER_READER_STOCK_MISMATCH', 'Pre-order inventory snapshot disagrees with stored books', 503)
    }
  }

  return {
    enabled,
    price_usd: price,
    quota,
    paid_reserved: paidReserved,
    payment_pending_held: pendingHeld,
    available: enabled ? quota - paidReserved - pendingHeld : 0,
  }
}

function readableBook(book, snapshot) {
  return {
    id: book.id,
    campaign_id: book.campaign_id,
    position: inventoryNumber(book.position, 'volume position'),
    title: book.title,
    cover_url: book.cover_url,
    editions: {
      standard: readableEdition(book, 'standard', snapshot),
      limited: readableEdition(book, 'limited', snapshot),
    },
  }
}

function readableCampaign(row, bookRows, stockByBook = null) {
  if (!bookRows.length || bookRows.length > MAX_VOLUMES) {
    throw preOrderError('PRE_ORDER_READER_VOLUMES_INVALID', 'The pre-order must contain between 1 and 10 volumes', 503)
  }
  const books = bookRows.map(book => {
    const snapshot = stockByBook?.get(String(book.id).toLowerCase())
    if (stockByBook && !snapshot) {
      throw preOrderError('PRE_ORDER_READER_STOCK_MISSING', 'A pre-order volume has no inventory snapshot', 503)
    }
    return readableBook(book, snapshot)
  })
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
    signature_fee_usd: money(row.signature_fee_usd ?? 0, 'signature fee'),
    signature_note: row.signature_note,
    delivery_note: row.delivery_note,
    buyer_note_instruction: row.buyer_note_instruction,
    books,
    available_volumes: books.length,
    multi_volume: books.length > 1,
    book: books[0],
    stock_snapshot_complete: stockByBook !== null,
  }
}

async function getBooks(campaignIds) {
  const result = new Map()
  if (!campaignIds.length) return result
  const { data, error } = await supabase.from('author_preorder_books')
    .select(BOOK_FIELDS)
    .in('campaign_id', campaignIds)
    .order('position', { ascending: true })
    .order('id', { ascending: true })
  storageError(error, 'BOOKS')
  for (const row of data || []) {
    const books = result.get(row.campaign_id) || []
    books.push(row)
    result.set(row.campaign_id, books)
  }
  return result
}

async function getVerifiedStock(campaignId, expectedBooks) {
  const { data, error } = await supabase.rpc('author_preorder_stock_snapshot_multivolume', {
    p_campaign_id: campaignId,
  })
  if (error) {
    const paymentEnabled = getAuthorPreOrderPaymentAvailability().payment_enabled === true
    if (MISSING_RPC.has(String(error.code || '')) && !paymentEnabled) {
      return null
    }
    storageError(error, 'STOCK')
  }
  if (!Array.isArray(data) || data.length !== expectedBooks.length) {
    throw preOrderError('PRE_ORDER_READER_STOCK_INCOMPLETE', 'Pre-order stock snapshot is incomplete', 503)
  }
  const byBook = new Map()
  for (const row of data) {
    const id = preOrderUuid(row?.book_id, 'stock volume ID').toLowerCase()
    if (byBook.has(id)) {
      throw preOrderError('PRE_ORDER_READER_STOCK_DUPLICATE', 'Duplicate volume inventory snapshot', 503)
    }
    byBook.set(id, row)
  }
  return byBook
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
  const rows = data || []
  const booksByCampaign = await getBooks(rows.map(row => row.id))
  const records = rows
    .filter(row => {
      const books = booksByCampaign.get(row.id) || []
      return books.length >= 1 && books.length <= MAX_VOLUMES
    })
    .map(row => readableCampaign(row, booksByCampaign.get(row.id)))
  return {
    records,
    page,
    limit,
    total: Number(count || 0),
    has_more: offset + rows.length < Number(count || 0),
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
  if (!data || data.author?.status !== 'active') {
    throw preOrderError('PRE_ORDER_READER_NOT_FOUND', 'Pre-order is not available', 404)
  }
  const booksByCampaign = await getBooks([id])
  const bookRows = booksByCampaign.get(id) || []
  if (!bookRows.length || bookRows.length > MAX_VOLUMES) {
    throw preOrderError('PRE_ORDER_READER_VOLUMES_INVALID', 'The pre-order volume list is unavailable', 503)
  }
  const stockByBook = await getVerifiedStock(id, bookRows)
  const record = readableCampaign(data, bookRows, stockByBook)
  if (!includeDelivery) return record

  let settings
  try {
    settings = await getAuthorCheckoutDeliverySettings(record.author_page_id)
  } catch (cause) {
    console.error('PRE_ORDER_READER_DELIVERY_STORAGE:', String(cause?.code || 'unknown'))
    throw preOrderError('PRE_ORDER_READER_DELIVERY_UNAVAILABLE', 'Delivery settings are temporarily unavailable', 503)
  }
  if (!Array.isArray(settings) || !Array.isArray(data.delivery_company_keys)) {
    throw preOrderError('PRE_ORDER_READER_DELIVERY_INVALID', 'Delivery settings are incomplete', 503)
  }
  const allowed = new Set(data.delivery_company_keys)
  record.delivery_companies = settings
    .filter(company => company?.is_active !== false && allowed.has(company?.company_key))
    .map(company => ({
      company_key: company.company_key,
      company_name: company.company_name,
      fee_usd: money(company.fee_usd, 'delivery fee'),
      logo_url: company.logo_url || '',
    }))
  return record
}
