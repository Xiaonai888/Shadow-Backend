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
  value = value.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [hidden]')
  value = value.replace(/https?:\/\/[^\s]+/gi, '[external URL hidden]')
  return value.replace(/[\r\n\t]+/g, ' ').slice(0, 240)
}

export function diagnoseAdminFinancialReportsError(error, {
  spreadsheetUrl = '',
  spreadsheetId = '',
  secret = '',
  task = 'CONNECT',
} = {}) {
  const savedId = sheetId(spreadsheetId)
  const enteredId = inputSheetId(spreadsheetUrl)
  const sameId = enteredId && savedId ? enteredId === savedId : null
  const source = safeSourceMessage(error, text(secret))
  const failedStatus = Number(error?.statusCode)
  const name = text(error?.name)
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
  }
  let message = 'Financial Reports failed. Check Render logs and Google Apps Script executions.'

  if (/unauthorized request/i.test(source)) {
    response.code = 'APPS_SCRIPT_SECRET_REJECTED'
    response.origin = 'Google Apps Script → verifySecret_'
    response.field = 'SHADOW_ADMIN_FINANCIAL_SECRET'
    response.step = 'Compare Render → Shadow-Backend → Environment with Google Apps Script → Project Settings → Script Properties. Also verify the deployed Web App belongs to this Apps Script project.'
    response.secret_status = 'Rejected by Apps Script'
    message = `Google Apps Script rejected SHADOW_ADMIN_FINANCIAL_SECRET. Render secret exists: ${response.render_secret_present ? 'yes' : 'no'}; length: ${response.render_secret_length} characters. ${response.step}`
  } else if (/illegal spreadsheet id or key|invalid spreadsheet id|spreadsheet.*not found|failed to open.*spreadsheet/i.test(source)) {
    response.code = 'GOOGLE_SHEET_OPEN_FAILED'
    response.origin = 'Google Apps Script → SpreadsheetApp.openById'
    response.field = 'SHADOW_ADMIN_FINANCIAL_SHEET_ID'
    response.step = 'Compare the ID with the real Google Sheets address bar. If the ID is correct, ensure the Google account selected under Web App → Execute as can open and edit that Sheet.'
    response.secret_status = 'Accepted by Apps Script'
    message = `Google Apps Script accepted the Secret, but could not open Google Sheet. Render Sheet ID: ${savedId || '(invalid)'}. Admin Link ID: ${enteredId || '(missing)'}. IDs match: ${sameId === null ? 'unknown' : sameId ? 'YES' : 'NO'}. ${response.step}`
  } else if (/permission|access denied|not authorized to call|cannot access|you do not have access|authorization is required/i.test(source)) {
    response.code = 'GOOGLE_SHEET_PERMISSION_DENIED'
    response.origin = 'Google Apps Script → Google Sheets authorization'
    response.field = 'Google Sheet sharing / Web App Execute as'
    response.step = 'Open the Google Sheet with the Web App deployment owner account, grant Editor access if needed, and authorize the Apps Script project.'
    response.secret_status = 'Likely accepted by Apps Script'
    message = `Google Sheets authorization or permission failed. ${response.step}`
  } else if (/not configured|missing|required environment/i.test(source)) {
    response.code = 'RENDER_FINANCIAL_CONFIGURATION_MISSING'
    response.origin = 'Render → Shadow-Backend → Environment'
    response.field = 'SHADOW_ADMIN_FINANCIAL_WEB_APP_URL / SHADOW_ADMIN_FINANCIAL_SECRET / SHADOW_ADMIN_FINANCIAL_SHEET_ID'
    response.step = 'Set all three variables in Render and deploy the Backend.'
    message = `Render Financial Reports configuration is incomplete or invalid. ${response.step}`
  } else if (/does not match.*SHADOW_ADMIN_FINANCIAL_SHEET_ID/i.test(source)) {
    response.code = 'ADMIN_SHEET_LINK_MISMATCH'
    response.origin = 'Shadow Backend → Google Sheet link check'
    response.field = 'SHADOW_ADMIN_FINANCIAL_SHEET_ID'
    response.step = 'Copy the Google Sheet URL directly from the address bar, then update the Sheet ID variable on Render if needed.'
    message = `Admin Link ID and Render Sheet ID differ. Render: ${savedId || '(invalid)'}. Admin Link: ${enteredId || '(invalid)'}. ${response.step}`
  } else if (/non-json response|unexpected token.*html|unexpected token.*</i.test(source)) {
    response.code = 'APPS_SCRIPT_INVALID_RESPONSE'
    response.origin = 'Render Backend → Apps Script Web App'
    response.field = 'SHADOW_ADMIN_FINANCIAL_WEB_APP_URL'
    response.step = 'Confirm the URL is the Web App /exec URL and that the deployment is accessible to Backend requests.'
    message = `Google Apps Script returned a non-JSON response. ${response.step}`
  } else if (/timed out|aborterror/i.test(source) || name === 'AbortError') {
    response.code = 'APPS_SCRIPT_TIMEOUT'
    response.origin = 'Render Backend → Apps Script Web App'
    response.field = 'SHADOW_ADMIN_FINANCIAL_WEB_APP_URL'
    response.step = 'Check the Apps Script execution history; the request exceeded the Backend timeout.'
    message = `Google Apps Script did not finish in time. ${response.step}`
  } else if (/fetch failed|network|econnreset|enotfound|etimedout/i.test(source)) {
    response.code = 'APPS_SCRIPT_NETWORK_FAILURE'
    response.origin = 'Render Backend → Google Apps Script network'
    response.field = 'SHADOW_ADMIN_FINANCIAL_WEB_APP_URL'
    response.step = 'Check the Web App /exec URL and outbound access from Render.'
    message = `Backend could not reach Google Apps Script. ${response.step}`
  } else if (failedStatus === 409 || failedStatus === 429 || failedStatus === 413) {
    response.code = failedStatus === 409 ? 'FINANCIAL_REPORTS_BUSY' : failedStatus === 429 ? 'FINANCIAL_REPORTS_RATE_LIMIT' : 'FINANCIAL_REPORTS_TOO_MANY_ROWS'
    response.origin = 'Shadow Backend → Financial Reports Sync'
    message = source || 'Financial Reports is temporarily unavailable.'
    response.step = message
  } else if (failedStatus === 400 || failedStatus === 503) {
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
