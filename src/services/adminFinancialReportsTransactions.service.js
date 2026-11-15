const ALLOWED_TYPES = new Set([
  'diamond_topup',
  'episode_unlock',
  'pdf_sale',
  'book_sale',
  'diamond_gift',
])

function stringValue(value, maxLength = 200) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function amount(value, field) {
  if (value === undefined || value === null || value === '') return 0
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Invalid ${field}`)
  }
  return Math.round((number + Number.EPSILON) * 100) / 100
}

function rate(value, field) {
  if (value === undefined || value === null || value === '') return 0
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Invalid ${field}`)
  }
  return number
}

function percentage(value, field) {
  if (value === undefined || value === null || value === '') return ''
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > 100) {
    throw new Error(`Invalid ${field}`)
  }
  return number
}

function date(value, field) {
  if (!value) throw new Error(`Missing ${field}`)
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid ${field}`)
  return parsed.toISOString()
}

function textList(value, maxLength = 250) {
  if (Array.isArray(value)) {
    return stringValue(value.filter(Boolean).join(', '), maxLength)
  }
  return stringValue(value, maxLength)
}

export function normalizeAdminFinancialTransaction(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('Invalid financial transaction')
  }

  const transactionKey = stringValue(entry.transaction_key, 200)
  if (!transactionKey || /^[=+\-@']/.test(transactionKey)) {
    throw new Error('Invalid transaction key')
  }

  const type = stringValue(entry.revenue_type, 40).toLowerCase()
  if (!ALLOWED_TYPES.has(type)) throw new Error('Unsupported revenue type')

  const occurredAt = date(entry.occurred_at, 'occurred_at')
  const updatedAt = date(entry.updated_at || entry.occurred_at, 'updated_at')
  const sales = amount(entry.product_sales_usd, 'product_sales_usd')
  const shipping = amount(entry.shipping_fee_usd, 'shipping_fee_usd')
  const received = amount(entry.cash_received_usd, 'cash_received_usd')
  const refunded = amount(entry.cash_refunded_usd, 'cash_refunded_usd')
  const authorEarn = amount(entry.author_earn_usd, 'author_earn_usd')
  const platformEarn = amount(entry.platform_earn_usd, 'platform_earn_usd')
  const spentDiamonds = amount(entry.spent_diamonds, 'spent_diamonds')
  const distributable = amount(entry.distributable_usd, 'distributable_usd')

  if (type === 'diamond_topup') {
    if (sales || shipping || authorEarn || platformEarn || spentDiamonds || distributable) {
      throw new Error('Diamond top-up cannot create earnings or diamond spending')
    }
  }

  if (type === 'episode_unlock' || type === 'diamond_gift') {
    if (received || refunded || shipping) {
      throw new Error('Diamond spending is not new cash revenue')
    }
  }

  if (type !== 'book_sale' && shipping) {
    throw new Error('Shipping is supported for book sales only')
  }

  if (type !== 'diamond_topup' && Number(entry.topup_cash_usd || 0) !== 0) {
    throw new Error('Top-up cash belongs to diamond top-ups only')
  }

  const result = {
    transaction_key: transactionKey,
    occurred_at: occurredAt,
    updated_at: updatedAt,
    revenue_type: type,
    sales_channel: stringValue(entry.sales_channel, 170),
    item_title: stringValue(entry.item_title, 250),
    author_name: stringValue(entry.author_name, 165),
    reference_id: stringValue(entry.reference_id, 200),
    status: stringValue(entry.status, 100),
    applied_share_rule: stringValue(entry.applied_share_rule, 175),
    eligible_share_events: textList(entry.eligible_share_events, 250),
    discount_events: textList(entry.discount_events, 200),
    original_price_usd: amount(entry.original_price_usd, 'original_price_usd'),
    discount_percent: percentage(entry.discount_percent, 'discount_percent'),
    discount_usd: amount(entry.discount_usd, 'discount_usd'),
    product_sales_usd: sales,
    shipping_fee_usd: shipping,
    cash_received_usd: received,
    cash_refunded_usd: refunded,
    topup_cash_usd: type === 'diamond_topup' ? received : 0,
    spent_diamonds: spentDiamonds,
    diamond_to_usd_rate: rate(entry.diamond_to_usd_rate, 'diamond_to_usd_rate'),
    author_share_percent: percentage(entry.author_share_percent, 'author_share_percent'),
    platform_share_percent: percentage(entry.platform_share_percent, 'platform_share_percent'),
    author_earn_usd: authorEarn,
    platform_earn_usd: platformEarn,
    distributable_usd: distributable,
    currency: stringValue(entry.currency || 'USD', 10),
    notes: stringValue(entry.notes, 290),
  }

  return result
}

export function normalizeAdminFinancialBatch(entries) {
  if (!Array.isArray(entries) || entries.length > 500) {
    throw new Error('Financial batch must contain 0 to 500 transactions')
  }

  const keys = new Set()
  return entries.map((entry) => {
    const row = normalizeAdminFinancialTransaction(entry)
    if (keys.has(row.transaction_key)) {
      throw new Error('Duplicate financial transaction key in batch')
    }
    keys.add(row.transaction_key)
    return row
  })
}
