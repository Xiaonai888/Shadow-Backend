import { supabase } from '../config/supabase.js'
import {
  SMART_PDF_POLICY,
  SMART_PDF_LANGUAGE_NAMES,
  normalizeSmartPdfLanguage,
  evaluateSmartPdfEligibility,
} from './smartPdfPolicy.service.js'

const PRODUCT_COLUMNS = [
  'id', 'author_page_id', 'product_type', 'status', 'title', 'author_name',
  'novel_type', 'category', 'genre', 'description', 'cover_url',
  'original_price', 'sale_price', 'pdf_file_url', 'pdf_storage_key', 'created_at',
].join(',')

const pages = new Map()
const pending = new Map()
const counts = new Map()
let epoch = 0

function validLanguage(value) {
  const language = normalizeSmartPdfLanguage(value)
  if (!language) throw new TypeError('Invalid PDF Story Language')
  return language
}

function check(result, label) {
  if (result?.error) throw new Error(`${label}: ${result.error.message}`)
  return result?.data || []
}

function cached(key, now) {
  const entry = pages.get(key)
  if (!entry || entry.expiresAt <= now) {
    pages.delete(key)
    return null
  }
  return entry.value
}

function store(key, value, now) {
  pages.delete(key)
  while (pages.size >= SMART_PDF_POLICY.maxCatalogCacheEntries) {
    pages.delete(pages.keys().next().value)
  }
  pages.set(key, { value, expiresAt: now + SMART_PDF_POLICY.catalogCacheMs })
}

export function invalidateSmartPdfCatalog() {
  epoch += 1
  pages.clear()
  pending.clear()
  counts.clear()
}

export async function getSmartPdfCatalogCount({ language = 'km', db = supabase, now = Date.now() } = {}) {
  const selected = validLanguage(language)
  const key = `${selected}`
  const current = db === supabase ? counts.get(key) : null
  if (current && current.expiresAt > now) return current.value
  const { count, error } = await db.from('author_store_products')
    .select('id', { count: 'exact', head: true })
    .eq('product_type', 'pdf')
    .eq('status', 'active')
    .eq('novel_type', SMART_PDF_LANGUAGE_NAMES[selected])
  if (error) throw error
  const value = Math.max(0, Number(count) || 0)
  if (db === supabase) counts.set(key, { value, expiresAt: Date.now() + SMART_PDF_POLICY.catalogCacheMs })
  return value
}

export async function readSmartPdfCandidatePage({
  language = 'km', offset = 0, limit = SMART_PDF_POLICY.pageSize,
  db = supabase, now = Date.now(), force = false,
} = {}) {
  const selected = validLanguage(language)
  const start = Number(offset)
  const take = Number(limit)
  if (!Number.isSafeInteger(start) || start < 0 || start > 1000000 ||
      !Number.isSafeInteger(take) || take < 1 || take > SMART_PDF_POLICY.pageSize) {
    throw new RangeError('Invalid PDF catalog pagination')
  }
  const cacheable = db === supabase
  const key = `${epoch}:${selected}:${start}:${take}`
  if (cacheable && !force) {
    const existing = cached(key, now)
    if (existing) return existing
    if (pending.has(key)) return pending.get(key)
  }
  const version = epoch
  const task = (async () => {
    const products = check(await db.from('author_store_products')
      .select(PRODUCT_COLUMNS)
      .eq('product_type', 'pdf')
      .eq('status', 'active')
      .eq('novel_type', SMART_PDF_LANGUAGE_NAMES[selected])
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(start, start + take - 1), 'PDF catalog products')
    const authorIds = [...new Set(products.map((item) => String(item.author_page_id || '')).filter(Boolean))]
    const authors = authorIds.length
      ? check(await db.from('author_pages')
        .select('id,status,page_name,page_username')
        .in('id', authorIds)
        .eq('status', 'active'), 'PDF catalog author pages')
      : []
    const authorsById = new Map(authors.map((author) => [String(author.id), author]))
    const records = []
    for (const item of products) {
      const decision = evaluateSmartPdfEligibility(item, authorsById.get(String(item.author_page_id)), selected)
      if (decision.eligible) records.push(decision.record)
    }
    const result = {
      records,
      scanned: products.length,
      next_offset: products.length < take ? null : start + take,
    }
    if (cacheable && epoch === version) store(key, result, Date.now())
    return result
  })()
  if (cacheable) pending.set(key, task)
  try {
    return await task
  } finally {
    if (pending.get(key) === task) pending.delete(key)
  }
}
