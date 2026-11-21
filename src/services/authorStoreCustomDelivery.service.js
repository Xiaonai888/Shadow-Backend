import { supabase } from '../config/supabase.js'

const TABLE = 'author_store_custom_delivery_companies'
const KEY = 'custom'
const MAX_NAME = 80
const MAX_FEE = 9999.99
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const FILE_NAME = /^\d{13}-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.(?:webp|jpg)$/i
const COLUMNS = 'author_page_id,user_id,company_name,fee_usd,logo_url,is_active,created_at,updated_at'

function clientError(code, message, statusCode = 400) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

function ownerId(value) {
  const id = String(value || '').trim()
  if (!UUID.test(id)) throw clientError('CUSTOM_DELIVERY_OWNER_INVALID', 'Valid author page required', 403)
  return id
}

export function validateAuthorStoreDeliveryLogoUrl(value, authorPageId, publicBase = process.env.R2_PUBLIC_URL) {
  const authorId = ownerId(authorPageId)
  const urlText = String(value ?? '').trim()
  const baseText = String(publicBase || '').trim().replace(/\/+$/, '')
  if (!baseText) {
    throw clientError('CUSTOM_DELIVERY_STORAGE_UNAVAILABLE', 'Company logo storage is not configured', 503)
  }

  let url
  let base
  try {
    url = new URL(urlText)
    base = new URL(baseText)
  } catch {
    throw clientError('CUSTOM_DELIVERY_LOGO_INVALID', 'Please upload a valid company logo')
  }

  if (url.protocol !== 'https:' || base.protocol !== 'https:' || url.username || url.password ||
    url.search || url.hash || base.username || base.password || base.search || base.hash ||
    url.origin !== base.origin) {
    throw clientError('CUSTOM_DELIVERY_LOGO_INVALID', 'Company logo must be uploaded to Shadow storage')
  }

  const basePath = base.pathname.replace(/\/+$/, '')
  const prefix = `${basePath}/author-store/delivery-logos/${authorId}/`
  if (!url.pathname.startsWith(prefix) || !FILE_NAME.test(url.pathname.slice(prefix.length))) {
    throw clientError('CUSTOM_DELIVERY_LOGO_INVALID', 'Company logo does not belong to this author page')
  }
  return url.href
}

export function parseCustomDeliveryCompanyInput(value, authorPageId, publicBase) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw clientError('CUSTOM_DELIVERY_INVALID', 'Custom delivery company is required')
  }
  if (String(value.company_key ?? value.companyKey ?? KEY).trim().toLowerCase() !== KEY) {
    throw clientError('CUSTOM_DELIVERY_KEY_INVALID', 'Invalid custom delivery company key')
  }

  const name = value.company_name ?? value.name
  if (typeof name !== 'string' || !name.trim() || name.trim().length > MAX_NAME || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw clientError('CUSTOM_DELIVERY_NAME_INVALID', 'Company name must be between 1 and 80 characters')
  }
  const rawFee = value.fee_usd ?? value.feeUsd
  const feeText = typeof rawFee === 'number' && Number.isFinite(rawFee) ? String(rawFee) :
    typeof rawFee === 'string' ? rawFee.trim() : ''
  if (!/^\d+(?:\.\d{1,2})?$/.test(feeText)) {
    throw clientError('CUSTOM_DELIVERY_FEE_INVALID', 'Delivery fee must have at most two decimal places')
  }
  const fee = Number(feeText)
  if (!Number.isFinite(fee) || fee < 0 || fee > MAX_FEE) {
    throw clientError('CUSTOM_DELIVERY_FEE_INVALID', 'Delivery fee must be from $0 to $9,999.99')
  }

  const logoUrl = validateAuthorStoreDeliveryLogoUrl(value.logo_url ?? value.logoUrl, authorPageId, publicBase)
  return {
    company_key: KEY,
    company_name: name.trim(),
    fee_usd: fee,
    logo_url: logoUrl,
    is_active: value.is_active !== false && value.enabled !== false,
  }
}

export function publicCustomDeliveryCompany(row) {
  if (!row) return null
  return {
    id: row.author_page_id,
    company_key: KEY,
    company_name: String(row.company_name || ''),
    short_name: String(row.company_name || ''),
    fee_usd: Number(row.fee_usd ?? 0),
    logo_url: String(row.logo_url || ''),
    is_active: row.is_active !== false,
    enabled: row.is_active !== false,
    sort_order: 2,
  }
}

export async function getAuthorStoreCustomDeliveryCompany(authorPageId, userId) {
  const pageId = ownerId(authorPageId)
  const { data, error } = await supabase
    .from(TABLE)
    .select(COLUMNS)
    .eq('author_page_id', pageId)
    .eq('user_id', String(userId || '').trim())
    .maybeSingle()
  if (error) throw error
  return publicCustomDeliveryCompany(data)
}

export async function saveAuthorStoreCustomDeliveryCompany(authorPageId, userId, input, options = {}) {
  const pageId = ownerId(authorPageId)
  const owner = String(userId || '').trim()
  if (!UUID.test(owner)) throw clientError('CUSTOM_DELIVERY_USER_INVALID', 'Valid account required', 401)
  const company = options.parsed || parseCustomDeliveryCompanyInput(input, pageId)
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from(TABLE)
    .upsert({
      author_page_id: pageId,
      user_id: owner,
      company_name: company.company_name,
      fee_usd: company.fee_usd,
      logo_url: company.logo_url,
      is_active: company.is_active,
      updated_at: now,
    }, { onConflict: 'author_page_id' })
    .select(COLUMNS)
    .single()
  if (error) throw error
  return publicCustomDeliveryCompany(data)
}

export async function deleteAuthorStoreCustomDeliveryCompany(authorPageId, userId) {
  const pageId = ownerId(authorPageId)
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq('author_page_id', pageId)
    .eq('user_id', String(userId || '').trim())
  if (error) throw error
  return true
}

export async function getOwnedActiveAuthorStorePage(userId) {
  const owner = String(userId || '').trim()
  if (!UUID.test(owner)) throw clientError('CUSTOM_DELIVERY_USER_INVALID', 'Valid account required', 401)
  const { data, error } = await supabase
    .from('author_pages')
    .select('id')
    .eq('user_id', owner)
    .eq('status', 'active')
    .maybeSingle()
  if (error) throw error
  if (!data?.id) throw clientError('CUSTOM_DELIVERY_AUTHOR_REQUIRED', 'Please create an active author page first', 403)
  return data.id
}
