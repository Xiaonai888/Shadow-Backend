import { preOrderError, preOrderUuid } from './authorPreOrderValidation.service.js'

export const PRE_ORDER_REPORT_MAX_EXPORT_ORDERS = 20000
export const PRE_ORDER_REPORT_EXPORT_PAGE_SIZE = 250

const EDITIONS = new Set(['all', 'standard', 'limited'])
const SORTS = new Set(['newest', 'oldest', 'highest'])

function optionalId(value, field) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw preOrderError('PRE_ORDER_REPORT_INVALID_FILTER', `Invalid ${field}`)
  return preOrderUuid(value, field)
}

function dateParts(value, field) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw preOrderError('PRE_ORDER_REPORT_INVALID_DATE', `Invalid ${field}`)
  }
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (year < 2000 || year > 2100 || parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) {
    throw preOrderError('PRE_ORDER_REPORT_INVALID_DATE', `Invalid ${field}`)
  }
  return { year, month, day }
}

function cambodiaMidnight(value) {
  if (!value) return null
  return new Date(Date.UTC(value.year, value.month - 1, value.day) - 7 * 60 * 60 * 1000).toISOString()
}

function afterCambodiaDay(value) {
  if (!value) return null
  return new Date(Date.UTC(value.year, value.month - 1, value.day + 1) - 7 * 60 * 60 * 1000).toISOString()
}

export function parsePreOrderReportFilters(query = {}, { exportAll = false } = {}) {
  const campaignId = optionalId(query.campaign_id ?? query.campaignId, 'campaign ID')
  const bookId = optionalId(query.book_id ?? query.bookId, 'book ID')
  const edition = String(query.edition ?? 'all').trim().toLowerCase()
  const sort = String(query.sort ?? 'newest').trim().toLowerCase()
  const fromDate = dateParts(query.from, 'start date')
  const toDate = dateParts(query.to, 'end date')
  if (!EDITIONS.has(edition) || !SORTS.has(sort)) {
    throw preOrderError('PRE_ORDER_REPORT_INVALID_FILTER', 'Invalid edition or sort order')
  }
  const fromAt = cambodiaMidnight(fromDate)
  const toExclusive = afterCambodiaDay(toDate)
  if (fromAt && toExclusive && fromAt >= toExclusive) {
    throw preOrderError('PRE_ORDER_REPORT_INVALID_DATE', 'Start date must not be after end date')
  }
  const page = exportAll ? 1 : Number(query.page ?? 1)
  const limit = exportAll ? PRE_ORDER_REPORT_EXPORT_PAGE_SIZE : Number(query.limit ?? 20)
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !Number.isSafeInteger(limit) || limit < 1 || limit > (exportAll ? 250 : 50)) {
    throw preOrderError('PRE_ORDER_REPORT_INVALID_PAGE', 'Invalid report pagination')
  }
  return { campaignId, bookId, edition, sort, fromAt, toExclusive, page, limit }
}
