const SOURCE_TABLES = [
  { name: 'ABA / payment transactions', table: 'payment_transactions' },
  { name: 'Binance payments', table: 'binance_checkout_orders' },
  { name: 'Episode / Gift earnings', table: 'author_earnings', earnings: true },
  { name: 'Author Page PDF / Book orders', table: 'author_store_orders' },
]

function cambodiaMonth(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('Invalid transaction date in financial history')
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Phnom_Penh',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date)
  const year = parts.find((part) => part.type === 'year')?.value
  const month = parts.find((part) => part.type === 'month')?.value
  return `${year}-${month}`
}

async function oldestRecord(db, source) {
  let query = db.from(source.table)
    .select('created_at')
    .order('created_at', { ascending: true })
    .limit(1)
  if (source.earnings) {
    query = query.eq('currency', 'diamond').in('source_type', ['diamond_unlock', 'diamond_gift'])
  }
  const { data, error } = await query
  if (error) throw new Error(`Cannot determine financial history from ${source.name}: ${error.message || 'Query failed'}`)
  if (!Array.isArray(data)) throw new Error(`Invalid response while reading financial history from ${source.name}`)
  if (!data.length) return null
  const date = new Date(data[0].created_at)
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid earliest transaction date in ${source.name}`)
  return date
}

export async function getAdminFinancialHistoryRange(db, { now = new Date() } = {}) {
  if (!db || typeof db.from !== 'function') throw new TypeError('Supabase client is required')
  const currentMonth = cambodiaMonth(now)
  const dates = await Promise.all(SOURCE_TABLES.map((source) => oldestRecord(db, source)))
  const existing = dates.filter(Boolean)
  const oldest = existing.length ? new Date(Math.min(...existing.map((date) => date.getTime()))) : null
  const firstMonth = oldest ? cambodiaMonth(oldest) : currentMonth
  const startMonth = firstMonth > currentMonth ? currentMonth : firstMonth
  const [firstYear, firstNumber] = startMonth.split('-').map(Number)
  const [lastYear, lastNumber] = currentMonth.split('-').map(Number)
  return {
    ok: true,
    start_month: startMonth,
    end_month: currentMonth,
    months_total: (lastYear - firstYear) * 12 + lastNumber - firstNumber + 1,
    has_transactions: Boolean(oldest),
  }
}
