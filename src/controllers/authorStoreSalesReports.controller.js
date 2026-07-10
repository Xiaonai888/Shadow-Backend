const DEFAULT_TIMEOUT_MS = 30000

function cleanText(value) {
  return String(value ?? '').trim()
}

function getConfig() {
  return {
    webAppUrl: cleanText(process.env.GOOGLE_APPS_SCRIPT_WEB_APP_URL),
    appSecret: cleanText(process.env.GOOGLE_APPS_SCRIPT_APP_SECRET),
    editorEmail: cleanText(
      process.env.GOOGLE_SALES_REPORTS_EDITOR_EMAIL || 'shadowera12226@gmail.com'
    ),
  }
}

function buildAuthorPageMeta(authorPage = {}) {
  return {
    page_name: cleanText(authorPage.page_name) || 'Author Store',
    page_username: cleanText(authorPage.page_username),
    avatar_url: cleanText(
      authorPage.avatar_url ||
        authorPage.profile_image_url ||
        authorPage.logo_url
    ),
  }
}

export function isAuthorStoreSalesReportsConfigured() {
  const config = getConfig()
  return Boolean(config.webAppUrl && config.appSecret)
}

export function getAuthorStoreSalesReportsEditorEmail() {
  return getConfig().editorEmail
}

export function extractGoogleSpreadsheetId(value) {
  const input = cleanText(value)

  if (!input) {
    throw new Error('Google Sheet link is required')
  }

  const directMatch = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)

  if (directMatch?.[1]) {
    return directMatch[1]
  }

  if (/^[a-zA-Z0-9_-]{20,}$/.test(input)) {
    return input
  }

  try {
    const url = new URL(input)
    const id = cleanText(url.searchParams.get('id'))

    if (/^[a-zA-Z0-9_-]{20,}$/.test(id)) {
      return id
    }
  } catch {
    throw new Error('Invalid Google Sheet link')
  }

  throw new Error('Invalid Google Sheet link')
}

async function callAppsScript(action, payload = {}) {
  const config = getConfig()

  if (!config.webAppUrl || !config.appSecret) {
    throw new Error('Sales Reports integration is not configured')
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

  try {
    const response = await fetch(config.webAppUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      redirect: 'follow',
      signal: controller.signal,
      body: JSON.stringify({
        ...payload,
        action,
        secret: config.appSecret,
      }),
    })

    const text = await response.text()
    let data

    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      throw new Error('Apps Script returned an invalid response')
    }

    if (!response.ok || data.ok === false) {
      throw new Error(data.message || 'Apps Script request failed')
    }

    return data
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Apps Script request timed out')
    }

    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export async function testAuthorStoreSalesReportsSpreadsheet(
  spreadsheetId,
  authorPage = {}
) {
  return callAppsScript('connect', {
    spreadsheet_id: extractGoogleSpreadsheetId(spreadsheetId),
    author_page: buildAuthorPageMeta(authorPage),
  })
}

export async function appendAuthorStoreSalesReportRows(
  spreadsheetId,
  rows,
  authorPage = {}
) {
  return callAppsScript('append_rows', {
    spreadsheet_id: extractGoogleSpreadsheetId(spreadsheetId),
    rows: Array.isArray(rows) ? rows : [],
    author_page: buildAuthorPageMeta(authorPage),
  })
}
