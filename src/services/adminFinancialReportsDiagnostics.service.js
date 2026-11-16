const SHEET_ID_PATTERN = /^[a-zA-Z0-9_-]{20,}$/

function text(value) {
  return String(value ?? '').trim()
}

function sheetId(value) {
  const input = text(value)
  const match = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)
  const result = match?.[1] || input
  return SHEET_ID_PATTERN.test(result) ? result : ''
}

function inputSheetId(value) {
  try {
    const url = new URL(text(value))
    if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com') return ''
    return sheetId(url.pathname)
  } catch {
    return ''
  }
}

function safeSourceMessage(error, secret) {
  let value = text(error?.message || error)
  if (secret) value = value.split(secret).join('[hidden secret]')
  return value.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [hidden]')
    .replace(/https?:\/\/[^\s]+/gi, '[external URL hidden]')
    .replace(/[\r\n\t]+/g, ' ').slice(0, 240)
}

function transportInfo(error) {
  const raw = error?.transport
  if (!raw || typeof raw !== 'object') return null
  const validHosts = new Set(['script.google.com', 'script.googleusercontent.com', 'accounts.google.com'])
  const host = text(raw.response_host)
  return {
    phase: text(raw.phase).slice(0, 80),
    http_status: Number.isInteger(Number(raw.http_status)) ? Number(raw.http_status) : 0,
    response_host: validHosts.has(host) ? host : 'Other redirect host',
    content_type: text(raw.content_type).slice(0, 80),
    redirects: Math.max(0, Math.min(Number(raw.redirects) || 0, 10)),
    page_hint: text(raw.page_hint).slice(0, 150),
  }
}

export function diagnoseAdminFinancialReportsError(error, {
  spreadsheetUrl = '', spreadsheetId = '', secret = '', task = 'CONNECT',
} = {}) {
  const savedId = sheetId(spreadsheetId)
  const enteredId = inputSheetId(spreadsheetUrl)
  const sameId = enteredId && savedId ? enteredId === savedId : null
  const source = safeSourceMessage(error, text(secret))
  const failedStatus = Number(error?.statusCode)
  const transport = transportInfo(error)
  const response = {
    code: 'FINANCIAL_REPORTS_UNKNOWN_ERROR',
    origin: 'Shadow Backend',
    field: '',
    step: '',
    secret_status: 'Not verified',
    render_secret_present: Boolean(text(secret)),
    render_secret_length: text(secret).length,
    render_spreadsheet_id: savedId,
    admin_spreadsheet_id: enteredId,
    sheet_ids_match: sameId,
    ...(transport ? { transport } : {}),
  }
  let message = 'Financial Reports failed. Check Render logs and Google Apps Script executions.'

  if (/unauthorized request/i.test(source)) {
    response.code = 'APPS_SCRIPT_SECRET_REJECTED'
    response.origin = 'Google Apps Script → verifySecret_'
    response.field = 'SHADOW_ADMIN_FINANCIAL_SECRET'
    response.step = 'Compare Render → Shadow-Backend → Environment with Google Apps Script → Project Settings → Script Properties. Verify the Web App URL belongs to that Apps Script project.'
    response.secret_status = 'Rejected by Apps Script'
    message = `Google Apps Script rejected SHADOW_ADMIN_FINANCIAL_SECRET. Render secret exists: ${response.render_secret_present ? 'yes' : 'no'}; length: ${response.render_secret_length} characters. ${response.step}`
  } else if (/illegal spreadsheet id or key|invalid spreadsheet id|spreadsheet.*not found|failed to open.*spreadsheet/i.test(source)) {
    response.code = 'GOOGLE_SHEET_OPEN_FAILED'
    response.origin = 'Google Apps Script → SpreadsheetApp.openById'
    response.field = 'SHADOW_ADMIN_FINANCIAL_SHEET_ID'
    response.step = 'Compare Sheet ID with the address bar. If the ID is correct, verify the Google account used by Web App → Execute as can open and edit that Sheet.'
    response.secret_status = 'Accepted by Apps Script'
    message = `Apps Script accepted the Secret, but could not open the Sheet. Render Sheet ID: ${savedId || '(invalid)'}. Admin Link ID: ${enteredId || '(missing)'}. IDs match: ${sameId === null ? 'unknown' : sameId ? 'YES' : 'NO'}. ${response.step}`
  } else if (/permission|access denied|not authorized to call|cannot access|you do not have access|authorization is required/i.test(source)) {
    response.code = 'GOOGLE_SHEET_PERMISSION_DENIED'
    response.origin = 'Google Apps Script → Google Sheets authorization'
    response.field = 'Google Sheet sharing / Web App Execute as'
    response.step = 'Open the Sheet using the Web App deployment owner account, grant Editor access and authorize this Apps Script project.'
    response.secret_status = 'Likely accepted by Apps Script'
    message = `Google Sheets authorization or permission failed. ${response.step}`
  } else if (/not configured|missing|required environment/i.test(source)) {
    response.code = 'RENDER_FINANCIAL_CONFIGURATION_MISSING'
    response.origin = 'Render → Shadow-Backend → Environment'
    response.field = 'SHADOW_ADMIN_FINANCIAL_WEB_APP_URL / SHADOW_ADMIN_FINANCIAL_SECRET / SHADOW_ADMIN_FINANCIAL_SHEET_ID'
    response.step = 'Set all three Render environment variables and deploy the Backend.'
    message = `Render Financial Reports configuration is incomplete or invalid. ${response.step}`
  } else if (/does not match.*SHADOW_ADMIN_FINANCIAL_SHEET_ID/i.test(source)) {
    response.code = 'ADMIN_SHEET_LINK_MISMATCH'
    response.origin = 'Shadow Backend → Google Sheet link check'
    response.field = 'SHADOW_ADMIN_FINANCIAL_SHEET_ID'
    response.step = 'Copy the Google Sheet URL directly from the address bar and update the Render Sheet ID if needed.'
    message = `Admin Link ID and Render Sheet ID differ. Render: ${savedId || '(invalid)'}. Admin Link: ${enteredId || '(invalid)'}. ${response.step}`
  } else if (/non-json response|unexpected redirect|redirect limit|malformed redirect/i.test(source)) {
    response.code = 'APPS_SCRIPT_INVALID_RESPONSE'
    response.origin = transport?.phase || 'Render Backend → Apps Script ContentService'
    response.field = 'SHADOW_ADMIN_FINANCIAL_WEB_APP_URL / Google Apps Script Web App access'
    response.step = 'Check Google Apps Script → Executions for this POST. If doPost completed, the response redirect may have failed after the Sheet operation. Do not retry writes blindly. Confirm Web App → Execute as Me / Who has access Anyone.'
    const detail = transport
      ? `Step: ${transport.phase || 'unknown'}; HTTP: ${transport.http_status || 'unknown'}; host: ${transport.response_host || 'unknown'}; content type: ${transport.content_type || 'unknown'}; redirects: ${transport.redirects}; Google page: ${transport.page_hint || 'unidentified'}. `
      : ''
    message = `Google Apps Script returned a non-JSON response. ${detail}${response.step}`
  } else if (/timed out|aborterror/i.test(source) || error?.name === 'AbortError') {
    response.code = 'APPS_SCRIPT_TIMEOUT'
    response.origin = 'Render Backend → Apps Script Web App'
    response.field = 'SHADOW_ADMIN_FINANCIAL_WEB_APP_URL'
    response.step = 'Check Google Apps Script → Executions; the request exceeded Backend timeout. Avoid repeating writes until the execution outcome is known.'
    message = `Google Apps Script did not finish in time. ${response.step}`
  } else if (/network request failed|fetch failed|network|econnreset|enotfound|etimedout/i.test(source)) {
    response.code = 'APPS_SCRIPT_NETWORK_FAILURE'
    response.origin = 'Render Backend → Google Apps Script network'
    response.field = 'SHADOW_ADMIN_FINANCIAL_WEB_APP_URL'
    response.step = 'Check the /exec URL and outbound connectivity from Render.'
    message = `Backend could not reach Google Apps Script. ${response.step}`
  } else if ([409, 429, 413].includes(failedStatus)) {
    response.code = failedStatus === 409 ? 'FINANCIAL_REPORTS_BUSY' : failedStatus === 429 ? 'FINANCIAL_REPORTS_RATE_LIMIT' : 'FINANCIAL_REPORTS_TOO_MANY_ROWS'
    response.origin = 'Shadow Backend → Financial Reports Sync'
    message = source || 'Financial Reports is temporarily unavailable.'
    response.step = message
  } else if ([400, 503].includes(failedStatus)) {
    response.code = 'FINANCIAL_REPORTS_CONFIGURATION_OR_INPUT'
    response.origin = 'Shadow Backend → Financial Reports validation'
    response.step = source || 'Check the supplied Sheet URL and Render configuration.'
    message = response.step
  } else {
    response.code = 'FINANCIAL_REPORTS_UNCLASSIFIED'
    response.origin = `Shadow Backend / Google Apps Script (${text(task).slice(0, 15)})`
    response.step = 'See Google Apps Script → Executions and Render → Logs for the exact error.'
    message = `Financial Reports error: ${source || 'Unknown error'}. ${response.step}`
  }
  return {
    statusCode: [400, 409, 413, 429, 503].includes(failedStatus) ? failedStatus : 502,
    message: message.slice(0, 1000),
    diagnostic: response,
  }
}
