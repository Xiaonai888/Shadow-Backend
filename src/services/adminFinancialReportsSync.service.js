const BATCH_SIZE = 250
const MAX_ROWS_PER_RUN = 3000
const MIN_SYNC_INTERVAL_MS = 30000
const MAX_PERIOD_MS = 93 * 24 * 60 * 60 * 1000

function clean(value) {
  return String(value ?? '').trim()
}

function errorWithStatus(message, statusCode) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function currentCambodiaMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Phnom_Penh', year: 'numeric', month: '2-digit',
  }).formatToParts(now)
  const year = parts.find((part) => part.type === 'year')?.value
  const month = parts.find((part) => part.type === 'month')?.value
  return `${year}-${month}`
}

export function normalizeFinancialReportPeriod(input = {}, now = new Date()) {
  const month = clean(input.month)
  const from = clean(input.from)
  const to = clean(input.to)
  if (month && (from || to)) throw errorWithStatus('Choose month OR from/to, not both', 400)
  if (from || to) {
    const isoWithZone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i
    if (!isoWithZone.test(from) || !isoWithZone.test(to)) {
      throw errorWithStatus('from and to require full ISO timestamps with timezone', 400)
    }
    const start = Date.parse(from)
    const end = Date.parse(to)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > MAX_PERIOD_MS) {
      throw errorWithStatus('Financial report range must be greater than zero and at most 93 days', 400)
    }
    if (start > now.getTime()) throw errorWithStatus('Financial report range cannot start in the future', 400)
    return { from: new Date(start).toISOString(), to: new Date(end).toISOString() }
  }
  const selected = month || currentCambodiaMonth(now)
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(selected)) {
    throw errorWithStatus('Month must use YYYY-MM', 400)
  }
  if (selected > currentCambodiaMonth(now)) {
    throw errorWithStatus('Cannot sync a future month', 400)
  }
  return { month: selected }
}

export function createAdminFinancialReportsSyncService({
  loadRows,
  writeRows,
  connect,
  isConfigured,
  clock = () => new Date(),
} = {}) {
  if (![loadRows, writeRows, connect, isConfigured, clock].every((fn) => typeof fn === 'function')) {
    throw new TypeError('Financial report sync dependencies are required')
  }
  let active = false
  let lastConnect = null
  let lastSync = null
  let lastError = null

  function assertConfigured() {
    if (!isConfigured()) throw errorWithStatus('Admin Financial Reports is not configured on the server', 503)
  }

  async function exclusive(operation) {
    if (active) throw errorWithStatus('Financial Reports is already processing another request', 409)
    active = true
    lastError = null
    try {
      return await operation()
    } catch (error) {
      lastError = { message: clean(error?.message).slice(0, 200), at: clock().toISOString() }
      throw error
    } finally {
      active = false
    }
  }

  function status() {
    return {
      configured: Boolean(isConfigured()),
      busy: active,
      connected_in_this_process: Boolean(lastConnect),
      last_connected_at: lastConnect?.at || null,
      last_sync: lastSync,
      last_error: lastError,
    }
  }

  async function connectSheet() {
    assertConfigured()
    return exclusive(async () => {
      const result = await connect()
      if (result?.ok !== true) throw new Error('Financial Reports connect did not succeed')
      lastConnect = { at: clock().toISOString() }
      return {
        ok: true,
        spreadsheet_url: clean(result.spreadsheet_url),
        script_version: clean(result.script_version),
        transactions: Number(result.transactions || 0),
        connected_at: lastConnect.at,
      }
    })
  }

  async function syncPeriod(input = {}) {
    assertConfigured()
    const period = normalizeFinancialReportPeriod(input, clock())
    const key = JSON.stringify(period)
    if (active) throw errorWithStatus('Financial Reports is already processing another request', 409)
    if (lastSync?.period_key === key && clock().getTime() - Date.parse(lastSync.synced_at) < MIN_SYNC_INTERVAL_MS) {
      return { ok: true, reused: true, ...lastSync }
    }
    return exclusive(async () => {
      const result = await loadRows(period)
      if (!result || !Array.isArray(result.rows)) throw new Error('Financial source returned invalid rows')
      if (result.rows.length > MAX_ROWS_PER_RUN) {
        throw errorWithStatus('Too many transactions for one sync; choose a shorter from/to period', 413)
      }
      const totals = { appended: 0, updated: 0, skipped: 0, processed: 0, batches: 0 }
      const batches = []
      for (let index = 0; index < result.rows.length; index += BATCH_SIZE) {
        batches.push(result.rows.slice(index, index + BATCH_SIZE))
      }
      if (!batches.length && period.month) batches.push([])
      for (const rows of batches) {
        let response
        try {
          response = await writeRows(rows, { month: period.month || '' })
          if (response?.ok !== true) throw new Error('Google Sheets did not confirm the transaction batch')
          if (period.month && (
            response.report_month !== period.month ||
            !Array.isArray(response.updated_months) ||
            !response.updated_months.includes(period.month) ||
            !Number.isInteger(response.verified_rows) ||
            response.verified_rows !== rows.length
          )) {
            throw new Error(`Google Sheets did not verify report month ${period.month}; update and deploy Code.gs before syncing`)
          }
        } catch (error) {
          error.synced_rows = totals.processed
          throw error
        }
        totals.appended += Number(response.appended || 0)
        totals.updated += Number(response.updated || 0)
        totals.skipped += Number(response.skipped || 0)
        totals.processed += rows.length
        totals.batches += 1
      }
      lastSync = {
        ...totals,
        rows_found: result.rows.length,
        period,
        period_key: key,
        source_counts: result.source_counts || {},
        synced_at: clock().toISOString(),
      }
      return { ok: true, reused: false, ...lastSync }
    })
  }

  return { status, connectSheet, syncPeriod }
}
