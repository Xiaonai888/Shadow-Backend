function errorWithStatus(message, statusCode) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function configuredId(configuredValue) {
  const input = String(configuredValue ?? '').trim()
  const match = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)
  const id = match?.[1] || input
  return /^[a-zA-Z0-9_-]{20,}$/.test(id) ? id : ''
}

export function adminFinancialConfiguredSheetUrl(configuredValue) {
  const id = configuredId(configuredValue)
  return id ? `https://docs.google.com/spreadsheets/d/${id}/edit` : ''
}

export function validateAdminFinancialSheetLink(input, configuredValue) {
  const configured = configuredId(configuredValue)
  if (!configured) throw errorWithStatus('Admin Financial Reports is not configured on Render', 503)
  if (typeof input !== 'string' || !input.trim()) {
    throw errorWithStatus('Google Sheets link is required', 400)
  }
  let url
  try {
    url = new URL(input.trim())
  } catch {
    throw errorWithStatus('Invalid Google Sheets link', 400)
  }
  const match = url.pathname.match(/^\/spreadsheets\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/)
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' || !match || !/^[a-zA-Z0-9_-]{20,}$/.test(match[1])) {
    throw errorWithStatus('Invalid Google Sheets link', 400)
  }
  if (match[1] !== configured) {
    throw errorWithStatus('This Google Sheet does not match SHADOW_ADMIN_FINANCIAL_SHEET_ID on Render', 400)
  }
  return adminFinancialConfiguredSheetUrl(configured)
}
