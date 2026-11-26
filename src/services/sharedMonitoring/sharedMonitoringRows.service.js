import { resourceCostRange } from '../resourceCostMath.service.js'

const PAGE_SIZE = 750
const MAX_ROWS = 30000

export async function readSharedMonitoringRows({
  table,
  columns,
  timeField,
  from,
  to,
  filters = {},
  tieBreakers = [],
  pageSize = PAGE_SIZE,
  onPage = null,
  beforePage = null,
}, client = null) {
  const range = resourceCostRange(from, to, 35)
  if (!table || !columns || !timeField) throw new TypeError('A monitoring query must specify its source.')
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE) throw new RangeError('Invalid monitoring page size.')
  if (onPage !== null && typeof onPage !== 'function') throw new TypeError('Invalid monitoring page consumer.')
  if (beforePage !== null && typeof beforePage !== 'function') throw new TypeError('Invalid monitoring page guard.')
  const database = client || (await import('../../config/supabase.js')).supabase
  const rows = []

  for (let offset = 0; offset < MAX_ROWS; offset += pageSize) {
    if (beforePage) await beforePage()
    const size = Math.min(pageSize, MAX_ROWS - offset)
    let query = database.from(table)
      .select(columns)
      .gte(timeField, range.from)
      .lt(timeField, range.to)

    for (const [field, value] of Object.entries(filters)) {
      if (value !== null && value !== undefined) query = query.eq(field, value)
    }

    query = query.order(timeField, { ascending: true })
    for (const field of tieBreakers) query = query.order(field, { ascending: true })

    const { data, error } = await query.range(offset, offset + size - 1)
    if (error) throw new Error(`${table}: ${error.message || String(error)}`)
    if (!Array.isArray(data)) throw new Error(`${table}: invalid database response.`)

    if (data.length > size) throw new Error(`${table}: database returned more rows than requested.`)
    if (onPage) await onPage(data)
    else rows.push(...data)
    if (data.length < size) return rows
  }

  throw new RangeError(`${table}: monitoring row limit reached; reduce the date range.`)
}
