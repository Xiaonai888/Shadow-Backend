import { normalizeAdminFinancialTransaction } from './adminFinancialReportsTransactions.service.js'

function text(value) {
  return String(value ?? '').trim()
}

function number(value) {
  const parsed = Number(value ?? 0)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('Invalid financial source amount')
  return parsed
}

function usd(value) {
  return Math.round((number(value) + Number.EPSILON) * 100) / 100
}

function first(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== '')
}

function meta(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function cents(value) {
  return Math.round(number(value) * 100)
}

function distribute(amount, weights) {
  const total = cents(amount)
  if (!weights.length) return []
  const mass = weights.reduce((sum, weight) => sum + number(weight), 0)
  const allocated = []
  let used = 0
  weights.forEach((weight, index) => {
    const portion = index === weights.length - 1
      ? total - used
      : Math.floor(total * (mass ? number(weight) / mass : 1 / weights.length))
    allocated.push(portion / 100)
    used += portion
  })
  return allocated
}

function recorded(entry, fields) {
  const value = first(...fields.map((field) => entry?.[field]))
  return value === undefined ? null : number(value)
}

function channel(order, item) {
  const attribution = order?.request_payload?.checkout_attribution
  const products = Array.isArray(attribution?.items) ? attribution.items : []
  const product = products.find((row) => text(row?.product_id) === text(item?.product_id))
  const value = text(first(product?.purchase_source, product?.source, products.length === 1 ? attribution?.purchase_source : '', order?.source, order?.sales_channel, 'author_store'))
  const labels = {
    stories: 'Stories Page',
    manga: 'Manga Page',
    discover: 'Discover',
    discover_promotion: 'Discover',
    author_store: 'Author Page Store',
  }
  return labels[value] || value
}

function mapName(context, group, id, fallback = '') {
  const value = context?.[group] instanceof Map ? context[group].get(String(id)) : null
  return text(value?.page_name || value?.name || fallback)
}

export function mapAdminFinancialPayment(payment, context = {}) {
  const status = text(payment?.status).toLowerCase()
  const purchaseType = text(payment?.purchase_type || 'diamonds').toLowerCase()
  if (!['success', 'approved', 'confirmed', 'refunded'].includes(status) || purchaseType !== 'diamonds') return null
  if (!payment?.id) throw new Error('Payment is missing its ID')
  const paid = recorded(payment, ['amount_usd', 'package_usd'])
  if (paid === null) throw new Error('Payment is missing its USD amount')
  const buyer = mapName(context, 'users', payment.user_id)
  const diamondCount = number(payment.diamonds)
  const refunded = status === 'refunded'
  return normalizeAdminFinancialTransaction({
    transaction_key: `aba-topup:${payment.id}`,
    occurred_at: first(payment.paid_at, payment.confirmed_at, payment.released_at, payment.created_at),
    updated_at: first(payment.updated_at, payment.paid_at, payment.created_at),
    revenue_type: 'diamond_topup',
    sales_channel: text(payment.payment_method || 'ABA'),
    item_title: 'Diamond Top-Up',
    reference_id: text(first(payment.order_id, payment.tran_id, payment.id)),
    status,
    cash_received_usd: paid,
    cash_refunded_usd: refunded ? paid : 0,
    original_price_usd: paid,
    currency: 'USD',
    notes: [buyer ? `Buyer: ${buyer}` : '', diamondCount ? `${diamondCount} diamonds` : ''].filter(Boolean).join(' | '),
  })
}

export function mapAdminFinancialBinanceTopup(order, context = {}) {
  const status = text(order?.status).toLowerCase()
  if (!order?.credited_at || ['cancelled', 'expired', 'rejected'].includes(status)) return null
  if (!order?.id) throw new Error('Binance top-up is missing its ID')
  const paid = recorded(order, ['package_usd'])
  if (paid === null) throw new Error('Binance top-up is missing its USD package price')
  const buyer = mapName(context, 'users', order.user_id)
  return normalizeAdminFinancialTransaction({
    transaction_key: `binance-topup:${order.id}`,
    occurred_at: order.credited_at,
    updated_at: first(order.updated_at, order.credited_at),
    revenue_type: 'diamond_topup',
    sales_channel: 'Binance USDT',
    item_title: 'Diamond Top-Up',
    reference_id: text(order.id),
    status,
    cash_received_usd: paid,
    original_price_usd: paid,
    currency: 'USD',
    notes: [buyer ? `Buyer: ${buyer}` : '', number(order.diamonds) ? `${number(order.diamonds)} diamonds` : '', 'USD package value; USDT fee excluded'].filter(Boolean).join(' | '),
  })
}

export function mapAdminFinancialEarning(earning, context = {}) {
  const source = text(earning?.source_type)
  if (!['diamond_unlock', 'diamond_gift'].includes(source)) return null
  if (!earning?.id) throw new Error('Author earning is missing its ID')
  const isVoid = text(earning.earning_status).toLowerCase() === 'void'
  const rate = number(first(earning.diamond_to_usd_rate, 0.01))
  const paidDiamonds = isVoid ? 0 : number(earning.paid_diamonds)
  const netDiamonds = isVoid ? 0 : number(earning.net_paid_diamonds)
  const authorDiamonds = isVoid ? 0 : number(earning.author_earned_diamonds)
  const platformDiamonds = isVoid ? 0 : number(earning.platform_earned_diamonds)
  const metadata = meta(earning.metadata)
  const title = mapName(context, 'stories', earning.story_id, metadata.story_title)
  const author = mapName(context, 'authors', earning.author_id)
  const original = isVoid ? 0 : number(first(earning.original_diamonds, earning.paid_diamonds))
  const paidUsd = usd(paidDiamonds * rate)
  const originalUsd = usd(original * rate)
  const discount = Math.max(0, usd(originalUsd - paidUsd))
  const share = isVoid ? '' : first(earning.author_share_percent, '')
  const giftName = text(metadata.gift_name || 'Diamond Gift')
  const itemTitle = source === 'diamond_gift'
    ? (title ? `${giftName} — ${title}` : giftName)
    : (title || text(metadata.episode_title) || 'Episode Unlock')
  return normalizeAdminFinancialTransaction({
    transaction_key: `earning:${earning.id}`,
    occurred_at: earning.created_at,
    updated_at: first(earning.updated_at, earning.created_at),
    revenue_type: source === 'diamond_gift' ? 'diamond_gift' : 'episode_unlock',
    sales_channel: text(first(metadata.purchase_source, metadata.sales_channel, source === 'diamond_gift' ? 'Gift' : 'Story Reader')),
    item_title: itemTitle,
    author_name: author,
    reference_id: text(first(earning.unlock_transaction_id, metadata.purchase_key, earning.id)),
    status: text(earning.earning_status || 'unknown'),
    applied_share_rule: text(earning.share_source),
    eligible_share_events: metadata.eligible_share_events,
    discount_events: metadata.discount_events,
    original_price_usd: originalUsd,
    discount_percent: isVoid ? '' : first(earning.discount_percent, ''),
    discount_usd: discount,
    product_sales_usd: paidUsd,
    spent_diamonds: paidDiamonds,
    diamond_to_usd_rate: rate,
    author_share_percent: share,
    platform_share_percent: share === '' ? '' : 100 - number(share),
    author_earn_usd: usd(authorDiamonds * rate),
    platform_earn_usd: usd(platformDiamonds * rate),
    distributable_usd: usd(netDiamonds * rate),
    currency: 'USD',
    notes: isVoid ? 'Voided; financial values reversed' : `Direct cost: $${usd((paidDiamonds - netDiamonds) * rate).toFixed(2)}`,
  })
}

export function mapAdminFinancialAuthorStoreOrder(order, context = {}) {
  if (!order?.id) throw new Error('Author Store order is missing its ID')
  const status = text(order.payment_status).toLowerCase()
  const hasPaidEvidence = Boolean(first(order.paid_at, order.payment_confirmed_at))
  if (!['paid', 'refunded'].includes(status) && !hasPaidEvidence) return []
  const refunded = status === 'refunded' || text(first(order.order_status, order.status)).toLowerCase() === 'refunded'
  const items = Array.isArray(order.items) ? order.items : []
  if (!items.length) throw new Error(`Paid order ${order.id} has no items`)
  const known = items.map((item) => {
    const product = context?.products instanceof Map ? context.products.get(text(item.product_id)) : null
    const kind = text(first(item.product_type, item.type, product?.product_type)).toLowerCase()
    if (kind !== 'pdf' && kind !== 'book') throw new Error(`Unknown product type in order ${order.id}`)
    if (!item.id) throw new Error(`Missing order item ID in order ${order.id}`)
    const quantity = Math.max(1, number(first(item.quantity, 1)))
    const lineAmount = recorded(item, ['total_price', 'total_usd'])
    const unit = recorded(item, ['unit_price', 'unit_price_usd'])
    const sale = lineAmount ?? usd((unit ?? 0) * quantity)
    const originalUnit = recorded(item, ['original_unit_price', 'original_price', 'compare_at_price'])
    return { item, product, kind, sale, original: usd((originalUnit ?? unit ?? sale / quantity) * quantity) }
  })
  const originalSales = known.reduce((sum, entry) => sum + entry.sale, 0)
  const totalSales = recorded(order, ['product_subtotal_usd', 'subtotal_usd']) ?? usd(originalSales)
  const orderFee = recorded(order, ['platform_fee_usd'])
  const totalFees = orderFee ?? usd(known.reduce((sum, entry) => sum + (recorded(entry.item, ['platform_fee_usd', 'platform_fee']) ?? 0), 0))
  const orderAuthor = recorded(order, ['author_income_usd'])
  const totalAuthor = orderAuthor ?? usd(Math.max(0, totalSales - totalFees))
  const shipping = recorded(order, ['delivery_fee_usd']) ?? 0
  const totalCash = recorded(order, ['total_usd']) ?? usd(totalSales + shipping)
  const weights = known.map((entry) => entry.sale)
  const parts = distribute(refunded ? 0 : totalSales, weights)
  const fees = distribute(refunded ? 0 : totalFees, weights)
  const authors = distribute(refunded ? 0 : totalAuthor, weights)
  const firstBookIndex = known.findIndex((entry) => entry.kind === 'book')
  if (shipping > 0 && firstBookIndex < 0) throw new Error(`Shipping without a Book in order ${order.id}`)
  const occurredAt = first(order.paid_at, order.payment_confirmed_at, order.created_at)
  const buyer = mapName(context, 'users', first(order.buyer_id, order.user_id))
  return known.map(({ item, product, kind, original }, index) => {
    const sale = parts[index]
    const fullPrice = Math.max(original, sale)
    const discount = Math.max(0, usd(fullPrice - sale))
    return normalizeAdminFinancialTransaction({
      transaction_key: `store:${order.id}:${item.id}`,
      occurred_at: occurredAt,
      updated_at: first(order.updated_at, item.updated_at, occurredAt),
      revenue_type: kind === 'book' ? 'book_sale' : 'pdf_sale',
      sales_channel: channel(order, item),
      item_title: text(first(item.product_title, item.title, product?.title, 'Product')),
      author_name: mapName(context, 'authors', order.author_page_id),
      reference_id: text(first(order.order_id, order.order_number, order.id)),
      status: status || text(first(order.order_status, order.status, 'paid')),
      original_price_usd: refunded ? 0 : fullPrice,
      discount_usd: refunded ? 0 : discount,
      product_sales_usd: sale,
      shipping_fee_usd: index === firstBookIndex && !refunded ? shipping : 0,
      cash_received_usd: index === 0 ? totalCash : 0,
      cash_refunded_usd: index === 0 && refunded ? totalCash : 0,
      author_earn_usd: authors[index],
      platform_earn_usd: fees[index],
      distributable_usd: usd(authors[index] + fees[index]),
      currency: 'USD',
      notes: [buyer ? `Buyer: ${buyer}` : '', refunded ? 'Fully refunded' : ''].filter(Boolean).join(' | '),
    })
  })
}
