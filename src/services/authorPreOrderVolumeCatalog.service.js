import { supabase } from '../config/supabase.js'
import { getAuthorCheckoutDeliverySettings } from '../controllers/authorStore.controller.js'
import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'
import { preOrderMoneyCents, preOrderDollars } from './authorPreOrderReaderValidation.service.js'

const CAMPAIGN_FIELDS = [
  'id', 'author_page_id', 'title', 'description', 'genre', 'banner_url',
  'open_at', 'close_at', 'expected_ship_at', 'status', 'published_at',
  'signature_enabled', 'signature_fee_usd', 'signature_note',
  'delivery_company_keys', 'delivery_note', 'buyer_note_instruction',
  'author:author_pages!inner(id,page_name,page_username,status)',
].join(',')
const BOOK_FIELDS = [
  'id', 'campaign_id', 'position', 'title', 'cover_url',
  'standard_enabled', 'standard_price_usd', 'standard_quota', 'standard_reserved',
  'limited_enabled', 'limited_price_usd', 'limited_quota', 'limited_reserved',
].join(',')

function storageError(error, step) {
  if (!error) return
  console.error(`PRE_ORDER_VOLUME_${step}_DB:`, String(error.code || 'unknown'))
  if (step === 'STOCK' && ['PGRST202', '42883'].includes(String(error.code || ''))) {
    throw preOrderError('PRE_ORDER_VOLUME_STOCK_MIGRATION_REQUIRED', 'Multi-volume inventory snapshot has not been installed', 503)
  }
  throw preOrderError('PRE_ORDER_VOLUME_STORAGE_UNAVAILABLE', 'Volume information is temporarily unavailable', 503)
}

function safeNumber(value, field) {
  const amount = preOrderMoneyCents(value, field)
  return preOrderDollars(amount)
}

function stockEdition(book, snapshot, edition) {
  const prefix = edition === 'standard' ? 'standard' : 'limited'
  const enabled = book[`${prefix}_enabled`] === true
  const quota = Number(book[`${prefix}_quota`])
  const reserved = Number(book[`${prefix}_reserved`])
  const held = Number(snapshot?.[prefix]?.payment_pending_held)
  const available = Number(snapshot?.[prefix]?.available)
  const price = safeNumber(book[`${prefix}_price_usd`], `${prefix} price`)

  if (![quota, reserved, held, available].every(Number.isSafeInteger) ||
      quota < 0 || reserved < 0 || held < 0 || reserved + held > quota ||
      available !== (enabled ? quota - reserved - held : 0) ||
      snapshot?.[prefix]?.enabled !== enabled ||
      Number(snapshot?.[prefix]?.quota) !== quota ||
      Number(snapshot?.[prefix]?.paid_reserved) !== reserved) {
    throw preOrderError('PRE_ORDER_VOLUME_STOCK_INCONSISTENT', 'Volume inventory is inconsistent', 503)
  }

  return { enabled, price_usd: price, quota, paid_reserved: reserved, payment_pending_held: held, available }
}

export async function getPublicAuthorPreOrderVolumeCatalog(campaignId, { includeDelivery = true } = {}) {
  const id = preOrderUuid(campaignId, 'campaign ID')
  const { data: campaign, error: campaignError } = await supabase.from('author_preorder_campaigns')
    .select(CAMPAIGN_FIELDS)
    .eq('id', id)
    .in('status', ['scheduled', 'active'])
    .not('published_at', 'is', null)
    .eq('author.status', 'active')
    .maybeSingle()
  storageError(campaignError, 'CAMPAIGN')
  if (!campaign || campaign.author?.status !== 'active') {
    throw preOrderError('PRE_ORDER_VOLUME_NOT_FOUND', 'Pre-order is not publicly available', 404)
  }

  const [booksResult, stockResult] = await Promise.all([
    supabase.from('author_preorder_books').select(BOOK_FIELDS)
      .eq('campaign_id', id).order('position', { ascending: true }).limit(11),
    supabase.rpc('author_preorder_stock_snapshot_multivolume', { p_campaign_id: id }),
  ])
  storageError(booksResult.error, 'BOOKS')
  storageError(stockResult.error, 'STOCK')
  const bookRows = booksResult.data
  const stockRows = stockResult.data
  if (!Array.isArray(bookRows) || bookRows.length < 1 || bookRows.length > 10 ||
      !Array.isArray(stockRows) || stockRows.length !== bookRows.length) {
    throw preOrderError('PRE_ORDER_VOLUME_CATALOG_INVALID', 'Pre-order volume catalog is incomplete', 503)
  }
  const stockByBook = new Map(stockRows.map(item => [item.book_id, item]))
  if (stockByBook.size !== bookRows.length) {
    throw preOrderError('PRE_ORDER_VOLUME_CATALOG_INVALID', 'Volume stock data is incomplete', 503)
  }

  const books = bookRows.map(row => {
    const snapshot = stockByBook.get(row.id)
    if (!snapshot) {
      throw preOrderError('PRE_ORDER_VOLUME_STOCK_MISSING', 'Volume stock is unavailable', 503)
    }
    return {
      id: row.id,
      position: Number(row.position),
      title: row.title,
      cover_url: row.cover_url,
      editions: {
        standard: stockEdition(row, snapshot, 'standard'),
        limited: stockEdition(row, snapshot, 'limited'),
      },
    }
  })

  const record = {
    id: campaign.id,
    author_page_id: campaign.author_page_id,
    author: {
      page_name: campaign.author?.page_name || '',
      page_username: campaign.author?.page_username || '',
    },
    title: campaign.title,
    description: campaign.description,
    genre: campaign.genre,
    banner_url: campaign.banner_url,
    open_at: campaign.open_at,
    close_at: campaign.close_at,
    expected_ship_at: campaign.expected_ship_at,
    status: campaign.status,
    signature_enabled: campaign.signature_enabled === true,
    signature_fee_usd: safeNumber(campaign.signature_fee_usd, 'signature fee'),
    signature_note: campaign.signature_note,
    delivery_note: campaign.delivery_note,
    buyer_note_instruction: campaign.buyer_note_instruction,
    books,
    available_volumes: books.length,
  }
  if (!includeDelivery) return record

  let settings
  try {
    settings = await getAuthorCheckoutDeliverySettings(record.author_page_id)
  } catch (error) {
    console.error('PRE_ORDER_VOLUME_DELIVERY_FAILED:', String(error?.code || 'unknown'))
    throw preOrderError('PRE_ORDER_VOLUME_DELIVERY_UNAVAILABLE', 'Delivery settings are unavailable', 503)
  }
  if (!Array.isArray(settings) || !Array.isArray(campaign.delivery_company_keys)) {
    throw preOrderError('PRE_ORDER_VOLUME_DELIVERY_INVALID', 'Delivery settings are incomplete', 503)
  }
  const allowed = new Set(campaign.delivery_company_keys)
  record.delivery_companies = settings
    .filter(item => item?.is_active !== false && allowed.has(item?.company_key))
    .map(item => ({
      company_key: item.company_key,
      company_name: item.company_name,
      fee_usd: safeNumber(item.fee_usd, 'delivery fee'),
      logo_url: item.logo_url || '',
    }))
  return record
}
