import { shadowAiError } from './shadowAiPolicy.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function id(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw shadowAiError('SHADOW_AI_CONTEXT_INVALID', 'Invalid author or campaign ID', 400)
  return value.toLowerCase()
}
function open(record, now) {
  return record?.status === 'active' && Date.parse(record.open_at) <= now && Date.parse(record.close_at) > now
}
function same(value, expected) { return typeof value === 'string' && value.toLowerCase() === expected }
function unavailable() { return shadowAiError('SHADOW_AI_CAMPAIGN_UNAVAILABLE', 'This pre-order is not available', 409) }

export function createShadowAiPreOrderContext({ listCampaigns, getCampaign, now = Date.now } = {}) {
  if (typeof listCampaigns !== 'function' || typeof getCampaign !== 'function') throw new TypeError('Context dependencies are required')
  return {
    async list(authorPageId, { offset = 0 } = {}) {
      const author = id(authorPageId)
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000) throw shadowAiError('SHADOW_AI_CONTEXT_INVALID', 'Invalid campaign offset', 400)
      const time = now()
      const records = await listCampaigns(author, { offset, limit: 11, time })
      if (!Array.isArray(records) || records.length > 11) throw shadowAiError('SHADOW_AI_CONTEXT_UNAVAILABLE', 'Pre-order context is unavailable')
      const visible = records.slice(0, 10).filter(row => same(row.author_page_id, author) && open(row, time) && row.published_at && Array.isArray(row.books) && row.books.length > 0)
      return { campaigns: visible.map(row => ({ id: row.id, title: row.title, close_at: row.close_at, books: row.books.map(book => ({ id: book.id, title: book.title })) })), has_more: records.length > 10, next_offset: records.length > 10 ? offset + 10 : null, stock_verified: false }
    },
    async detail(authorPageId, campaignId) {
      const author = id(authorPageId)
      const campaign = id(campaignId)
      const record = await getCampaign(campaign)
      if (!record || !same(record.id, campaign) || !same(record.author_page_id, author) || !open(record, now())) throw unavailable()
      if (record.stock_snapshot_complete !== true || !Array.isArray(record.books) || !record.books.length || record.books.length > 10 || !Array.isArray(record.delivery_companies)) throw shadowAiError('SHADOW_AI_CONTEXT_UNAVAILABLE', 'Verified stock or delivery is unavailable')
      const books = record.books.map(book => {
        const editions = ['standard','limited'].flatMap(edition => {
          const item = book.editions?.[edition]
          if (!item || item.stock_verified !== true || !Number.isSafeInteger(item.available) || item.available < 0 || !Number.isFinite(item.price_usd) || item.price_usd < 0) throw shadowAiError('SHADOW_AI_CONTEXT_UNAVAILABLE', 'Verified stock is unavailable')
          return item.enabled ? [{ edition, price_usd: item.price_usd, available: item.available }] : []
        })
        return { id: id(book.id), title: book.title, editions }
      })
      const delivery = record.delivery_companies.map(company => ({ company_key: company.company_key, company_name: company.company_name, fee_usd: company.fee_usd }))
      return { campaign_id: campaign, author_page_id: author, title: record.title, description: record.description, open_at: record.open_at, close_at: record.close_at, expected_ship_at: record.expected_ship_at, books, delivery_companies: delivery, signature_enabled: record.signature_enabled === true, signature_fee_usd: record.signature_fee_usd, signature_note: record.signature_note, delivery_note: record.delivery_note, buyer_note_instruction: record.buyer_note_instruction, can_book: delivery.length > 0 && books.some(book => book.editions.some(edition => edition.available > 0)), stock_verified: true }
    },
  }
}
