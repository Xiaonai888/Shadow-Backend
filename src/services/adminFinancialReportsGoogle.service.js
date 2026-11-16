const REQUEST_TIMEOUT_MS = 30000
const MAX_BATCH_ROWS = 500
const MAX_REDIRECTS = 3
const TRUSTED_OUTPUT_HOST = 'script.googleusercontent.com'

function settings() {
  return {
    url: String(process.env.SHADOW_ADMIN_FINANCIAL_WEB_APP_URL || '').trim(),
    secret: String(process.env.SHADOW_ADMIN_FINANCIAL_SECRET || '').trim(),
    spreadsheetId: String(process.env.SHADOW_ADMIN_FINANCIAL_SHEET_ID || '').trim(),
  }
}

function validateSettings() {
  const config = settings()
  if (!config.url || !config.secret || !config.spreadsheetId) {
    throw new Error('Admin Financial Reports is not configured')
  }
  let endpoint
  try {
    endpoint = new URL(config.url)
  } catch {
    throw new Error('Invalid Admin Financial Reports Apps Script URL')
  }
  if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'script.google.com' ||
      !/^\/macros\/s\/[^/]+\/exec$/.test(endpoint.pathname)) {
    throw new Error('Invalid Admin Financial Reports Apps Script URL')
  }
  const match = config.spreadsheetId.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)
  const spreadsheetId = match?.[1] || config.spreadsheetId
  if (!/^[a-zA-Z0-9_-]{20,}$/.test(spreadsheetId)) {
    throw new Error('Invalid Admin Financial Reports spreadsheet ID')
  }
  return { ...config, spreadsheetId, url: endpoint.toString() }
}

function transportError(message, transport = {}) {
  const error = new Error(message)
  error.name = 'AdminFinancialGoogleTransportError'
  error.transport = {
    phase: String(transport.phase || 'request'),
    http_status: Number(transport.http_status || 0),
    content_type: String(transport.content_type || '').slice(0, 100),
    response_host: String(transport.response_host || '').slice(0, 100),
    redirects: Number(transport.redirects || 0),
    page_hint: String(transport.page_hint || '').slice(0, 130),
  }
  return error
}

function pageHint(body) {
  const content = String(body || '').slice(0, 4500)
  if (/script function not found\s*:\s*doGet/i.test(content)) return 'Google redirected to doGet instead of returning the POST result'
  if (/sorry,? unable to open the file|unable to open the file at this time/i.test(content)) return 'Google Drive cannot open the redirected web app response'
  if (/sign in.*google accounts|accounts\.google\.com|sign in to continue/i.test(content)) return 'Google sign-in page returned instead of JSON'
  if (/<title[^>]*>\s*404|404\s+not found/i.test(content)) return 'Google returned a 404 page'
  if (/<title[^>]*>\s*403|access denied|permission denied/i.test(content)) return 'Google rejected access to the web app response'
  if (/<html|<!doctype html/i.test(content)) return 'Google returned an HTML page instead of JSON'
  return 'The Apps Script response is not valid JSON'
}

async function requestJson(config, action, fields, signal) {
  const payload = JSON.stringify({
    ...fields,
    action,
    secret: config.secret,
    spreadsheet_id: config.spreadsheetId,
  })
  let response = await fetch(config.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: payload,
    redirect: 'manual',
    signal,
  })
  let redirects = 0
  let phase = 'Apps Script POST'

  while ([301, 302, 303, 307, 308].includes(response.status)) {
    if (redirects >= MAX_REDIRECTS) {
      throw transportError('Apps Script redirect limit exceeded', {
        phase, http_status: response.status, redirects,
      })
    }
    if (![301, 302, 303].includes(response.status)) {
      throw transportError('Apps Script returned an unexpected redirect that cannot safely be followed', {
        phase, http_status: response.status, redirects,
      })
    }
    let next
    try {
      next = new URL(response.headers.get('location') || '', response.url || config.url)
    } catch {
      throw transportError('Apps Script returned a malformed redirect target', {
        phase, http_status: response.status, redirects,
      })
    }
    if (next.protocol !== 'https:' || next.hostname !== TRUSTED_OUTPUT_HOST) {
      throw transportError('Apps Script redirected outside the trusted Google content endpoint', {
        phase, http_status: response.status, redirects,
        response_host: next.hostname,
        page_hint: next.hostname === 'accounts.google.com' ? 'Google sign-in is required' : 'Unexpected redirect destination',
      })
    }
    redirects += 1
    phase = 'Google ContentService redirect'
    response = await fetch(next.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal,
    })
  }

  const body = await response.text()
  let data
  try {
    data = JSON.parse(body)
  } catch {
    const origin = (() => {
      try { return new URL(response.url || config.url).hostname } catch { return '' }
    })()
    throw transportError('Admin Financial Reports returned a non-JSON response', {
      phase,
      http_status: response.status,
      content_type: response.headers.get('content-type') || '',
      response_host: origin,
      redirects,
      page_hint: pageHint(body),
    })
  }
  if (!response.ok || !data || data.ok !== true) {
    const reason = String(data?.message || 'Admin Financial Reports request failed').slice(0, 300)
    const error = new Error(reason)
    error.transport = {
      phase,
      http_status: response.status,
      response_host: (() => { try { return new URL(response.url || config.url).hostname } catch { return '' } })(),
      redirects,
    }
    throw error
  }
  return data
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
    return await requestJson(config, action, fields, controller.signal)
  } catch (error) {
    if (controller.signal.aborted) {
      throw transportError('Admin Financial Reports request timed out', { phase: 'Apps Script request timeout' })
    }
    if (error instanceof TypeError && !error.transport) {
      throw transportError('Admin Financial Reports network request failed', { phase: 'Apps Script network' })
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export function connectAdminFinancialReports() {
  return callFinancialScript('connect')
}

export function upsertAdminFinancialReportRows(rows, options = {}) {
  if (!Array.isArray(rows) || rows.length > MAX_BATCH_ROWS) {
    throw new Error(`Admin Financial Reports accepts at most ${MAX_BATCH_ROWS} rows per request`)
  }
  const month = String(options?.month || '').trim()
  if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error('Report month must use YYYY-MM')
  }
  if (!rows.length && !month) return Promise.resolve({ ok: true, appended: 0, updated: 0, skipped: 0 })
  return callFinancialScript('upsert_rows', { rows, ...(month ? { report_month: month } : {}) })
}
