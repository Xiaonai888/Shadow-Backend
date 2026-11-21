const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const COMPANY_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
const MAX_BOOKS = 10

export function preOrderError(code, message, statusCode = 400) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

export function preOrderUuid(value, field = 'ID') {
  const text = String(value || '').trim()
  if (!UUID.test(text)) throw preOrderError('PRE_ORDER_INVALID_ID', `Invalid ${field}`)
  return text
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw preOrderError('PRE_ORDER_INVALID_INPUT', `${field} must be an object`)
  }
  return value
}

function string(value, field, limit, required = false) {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw preOrderError('PRE_ORDER_INVALID_INPUT', `${field} must be text`)
  }
  const text = String(value || '').trim()
  if (text.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) || (required && !text)) {
    throw preOrderError('PRE_ORDER_INVALID_INPUT', `Invalid ${field}`)
  }
  return text
}

function date(value, field) {
  if (value === null || value === '' || value === undefined) return null
  if (typeof value !== 'string' || !DATE.test(value) || !Number.isFinite(Date.parse(value))) {
    throw preOrderError('PRE_ORDER_INVALID_DATE', `Invalid ${field}`)
  }
  return new Date(value).toISOString()
}

function amount(value, field, { allowZero = true } = {}) {
  const text = String(value ?? '').trim()
  if (!/^(?:0|[1-9]\d{0,3})(?:\.\d{1,2})?$/.test(text)) {
    throw preOrderError('PRE_ORDER_INVALID_PRICE', `Invalid ${field}`)
  }
  const number = Number(text)
  if (!Number.isFinite(number) || number > 9999.99 || (!allowZero && number <= 0)) {
    throw preOrderError('PRE_ORDER_INVALID_PRICE', `Invalid ${field}`)
  }
  return number
}

function integer(value, field) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0 || number > 1000000) {
    throw preOrderError('PRE_ORDER_INVALID_QUOTA', `Invalid ${field}`)
  }
  return number
}

function imageUrl(value, field) {
  const text = string(value, field, 2048)
  if (!text) return ''
  let url
  try {
    url = new URL(text)
  } catch {
    throw preOrderError('PRE_ORDER_INVALID_IMAGE', `Invalid ${field}`)
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
    throw preOrderError('PRE_ORDER_INVALID_IMAGE', `Invalid ${field}`)
  }
  const baseText = String(process.env.R2_PUBLIC_URL || '').trim()
  if (baseText) {
    let base
    try {
      base = new URL(baseText)
    } catch {
      throw preOrderError('PRE_ORDER_STORAGE_NOT_READY', 'Image storage is not configured', 503)
    }
    const prefix = base.pathname.replace(/\/+$/, '')
    if (url.origin !== base.origin || !url.pathname.startsWith(`${prefix}/`)) {
      throw preOrderError('PRE_ORDER_UNTRUSTED_IMAGE', `${field} must be uploaded to Shadow storage`)
    }
  }
  return url.href
}

function edition(value, name) {
  const entry = object(value, name)
  if (typeof entry.enabled !== 'boolean') {
    throw preOrderError('PRE_ORDER_INVALID_EDITION', `${name} enabled must be true or false`)
  }
  const price = amount(entry.price_usd ?? 0, `${name} price`)
  const quota = integer(entry.quota ?? 0, `${name} quota`)
  return { enabled: entry.enabled, price_usd: price, quota }
}

export function parseAuthorPreOrderDraft(input) {
  const data = object(input, 'Pre-order')
  const books = data.books
  if (!Array.isArray(books) || books.length < 1 || books.length > MAX_BOOKS) {
    throw preOrderError('PRE_ORDER_BOOKS_INVALID', 'A pre-order must contain 1 to 10 books')
  }
  const normalizedBooks = books.map((item, index) => {
    const book = object(item, `Book ${index + 1}`)
    const editions = object(book.editions, 'Editions')
    return {
      title: string(book.title, 'Book title', 180),
      cover_url: imageUrl(book.cover_url, 'Book image'),
      editions: {
        standard: edition(editions.standard, 'Standard edition'),
        limited: edition(editions.limited, 'Limited edition'),
      },
    }
  })
  const companies = data.delivery_company_keys
  if (!Array.isArray(companies) || companies.length > 32 || companies.some(key => typeof key !== 'string' || !COMPANY_KEY_PATTERN.test(key))) {
    throw preOrderError('PRE_ORDER_DELIVERY_INVALID', 'Invalid delivery companies')
  }
  const open = date(data.open_at, 'Open date')
  const close = date(data.close_at, 'Close date')
  const expected = date(data.expected_ship_at, 'Expected shipping date')
  if (open && close && Date.parse(open) >= Date.parse(close)) {
    throw preOrderError('PRE_ORDER_DATE_ORDER', 'Close date must be after open date')
  }
  if (close && expected && Date.parse(expected) < Date.parse(close)) {
    throw preOrderError('PRE_ORDER_DATE_ORDER', 'Shipping date must be on or after close date')
  }
  if (typeof data.signature_enabled !== 'boolean') {
    throw preOrderError('PRE_ORDER_SIGNATURE_INVALID', 'Invalid signature option')
  }
  return {
    title: string(data.title, 'Campaign title', 160),
    description: string(data.description, 'Description', 500),
    genre: string(data.genre, 'Genre', 160),
    author_note: string(data.author_note, 'Author note', 500),
    banner_url: imageUrl(data.banner_url, 'Promotion image'),
    open_at: open,
    close_at: close,
    expected_ship_at: expected,
    signature_enabled: data.signature_enabled,
    signature_fee_usd: amount(data.signature_fee_usd ?? 0, 'Signature fee'),
    signature_note: string(data.signature_note, 'Signature note', 200),
    delivery_company_keys: [...new Set(companies)],
    delivery_note: string(data.delivery_note, 'Delivery note', 300),
    buyer_note_instruction: string(data.buyer_note_instruction, 'Buyer note', 300),
    books: normalizedBooks,
  }
}

export function parseAuthorPreOrderListQuery(query = {}) {
  const status = String(query.status || 'all').trim().toLowerCase()
  const allowed = new Set(['all', 'draft', 'scheduled', 'active', 'closed', 'completed', 'cancelled'])
  if (!allowed.has(status)) throw preOrderError('PRE_ORDER_FILTER_INVALID', 'Invalid pre-order status')
  const page = Number(query.page ?? 1)
  const limit = Number(query.limit ?? 12)
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 24) {
    throw preOrderError('PRE_ORDER_PAGE_INVALID', 'Invalid pagination')
  }
  return { status, page, limit, search: string(query.search, 'Search', 100) }
}
