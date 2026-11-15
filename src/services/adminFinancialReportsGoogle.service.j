const REQUEST_TIMEOUT_MS = 30000
const MAX_BATCH_ROWS = 500

function getSettings() {
  return {
    url: String(process.env.SHADOW_ADMIN_FINANCIAL_WEB_APP_URL || '').trim(),
    secret: String(process.env.SHADOW_ADMIN_FINANCIAL_SECRET || '').trim(),
    spreadsheetId: String(process.env.SHADOW_ADMIN_FINANCIAL_SHEET_ID || '').trim(),
  }
}

function validateSettings() {
  const config = getSettings()

  if (!config.url || !config.secret || !config.spreadsheetId) {
    throw new Error('Admin Financial Reports is not configured')
  }

  let endpoint
  try {
    endpoint = new URL(config.url)
  } catch {
    throw new Error('Invalid Admin Financial Reports Apps Script URL')
  }

  if (
    endpoint.protocol !== 'https:' ||
    endpoint.hostname !== 'script.google.com' ||
    !/^\/macros\/s\/[^/]+\/exec$/.test(endpoint.pathname)
  ) {
    throw new Error('Invalid Admin Financial Reports Apps Script URL')
  }

  const spreadsheetMatch = config.spreadsheetId.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)
  const spreadsheetId = spreadsheetMatch?.[1] || config.spreadsheetId
  if (!/^[a-zA-Z0-9_-]{20,}$/.test(spreadsheetId)) {
    throw new Error('Invalid Admin Financial Reports spreadsheet ID')
  }

  return { ...config, spreadsheetId, url: endpoint.toString() }
}

export function isAdminFinancialReportsConfigured() {
  try {
    validateSettings()
    return true
  } catch {
    return false
  }
}

async function callFinancialScript(action, fields = {}) {
  const config = validateSettings()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...fields,
        action,
        secret: config.secret,
        spreadsheet_id: config.spreadsheetId,
      }),
      redirect: 'follow',
      signal: controller.signal,
    })

    const responseText = await response.text()
    let data
    try {
      data = JSON.parse(responseText)
    } catch {
      throw new Error('Admin Financial Reports returned a non-JSON response')
    }

    if (!response.ok || !data || data.ok !== true) {
      throw new Error(String(data?.message || 'Admin Financial Reports request failed').slice(0, 300))
    }

    return data
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Admin Financial Reports request timed out')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export function connectAdminFinancialReports() {
  return callFinancialScript('connect')
}

export function upsertAdminFinancialReportRows(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_BATCH_ROWS) {
    throw new Error(`Admin Financial Reports accepts at most ${MAX_BATCH_ROWS} rows per request`)
  }

  if (!rows.length) {
    return Promise.resolve({ ok: true, appended: 0, updated: 0, skipped: 0 })
  }

  return callFinancialScript('upsert_rows', { rows })
}
