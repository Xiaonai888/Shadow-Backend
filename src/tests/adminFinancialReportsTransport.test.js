import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import {
  connectAdminFinancialReports,
  upsertAdminFinancialReportRows,
  isAdminFinancialReportsConfigured,
} from '../services/adminFinancialReportsGoogle.service.js'
import { diagnoseAdminFinancialReportsError } from '../services/adminFinancialReportsDiagnostics.service.js'

const endpoint = 'https://script.google.com/macros/s/FAKE_DEPLOYMENT_FOR_TEST/exec'
const sheet = '1VzyAVRf8-JBoC5ECd3dnKqdeaxyNcHSJlUMUtM5mYFA'
const secret = 'TEST_SECRET_NOT_FOR_PRODUCTION_1234567890'
const originalEnv = Object.fromEntries([
  'SHADOW_ADMIN_FINANCIAL_WEB_APP_URL',
  'SHADOW_ADMIN_FINANCIAL_SECRET',
  'SHADOW_ADMIN_FINANCIAL_SHEET_ID',
].map((name) => [name, process.env[name]]))
const originalFetch = globalThis.fetch

process.env.SHADOW_ADMIN_FINANCIAL_WEB_APP_URL = endpoint
process.env.SHADOW_ADMIN_FINANCIAL_SECRET = secret
process.env.SHADOW_ADMIN_FINANCIAL_SHEET_ID = sheet

after(() => {
  globalThis.fetch = originalFetch
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

function response(body, { status = 200, contentType = 'application/json', headers = {} } = {}) {
  return new Response(body, { status, headers: { 'Content-Type': contentType, ...headers } })
}

test('configured service accepts the existing three Render variables', () => {
  assert.equal(isAdminFinancialReportsConfigured(), true)
})

test('connect sends the secret only in the initial Apps Script POST', async () => {
  let calls = 0
  globalThis.fetch = async (url, options) => {
    calls += 1
    assert.equal(url, endpoint)
    assert.equal(options.method, 'POST')
    assert.equal(options.redirect, 'manual')
    const data = JSON.parse(options.body)
    assert.equal(data.secret, secret)
    assert.equal(data.spreadsheet_id, sheet)
    assert.equal(data.action, 'connect')
    return response(JSON.stringify({ ok: true, spreadsheet_url: 'https://docs.google.com/spreadsheets/d/' + sheet + '/edit' }))
  }
  assert.equal((await connectAdminFinancialReports()).ok, true)
  assert.equal(calls, 1)
})

test('Google ContentService redirect is followed using GET without secret or body', async () => {
  const output = 'https://script.googleusercontent.com/macros/echo?user_content_key=TEST_ONLY'
  let calls = 0
  globalThis.fetch = async (url, options) => {
    calls += 1
    if (calls === 1) {
      assert.equal(url, endpoint)
      assert.equal(options.method, 'POST')
      return response('', { status: 302, headers: { Location: output } })
    }
    assert.equal(url, output)
    assert.equal(options.method, 'GET')
    assert.equal(options.body, undefined)
    assert.equal(options.headers.Authorization, undefined)
    assert.equal(options.headers['Content-Type'], undefined)
    return response(JSON.stringify({ ok: true, spreadsheet_id: sheet }))
  }
  assert.equal((await connectAdminFinancialReports()).ok, true)
  assert.equal(calls, 2)
})

test('rejects Google sign-in redirect without transmitting credentials', async () => {
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return response('', { status: 302, headers: { Location: 'https://accounts.google.com/ServiceLogin' } })
  }
  await assert.rejects(connectAdminFinancialReports(), (error) => {
    assert.match(error.message, /outside the trusted Google content endpoint/)
    assert.equal(error.transport.response_host, 'accounts.google.com')
    assert.equal(error.transport.http_status, 302)
    assert.equal(error.transport.page_hint, 'Google sign-in is required')
    return true
  })
  assert.equal(calls, 1)
})

test('redirected Google 404 HTML response is reported with safe structured details', async () => {
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    if (calls === 1) return response('', { status: 302, headers: { Location: 'https://script.googleusercontent.com/macros/echo?user_content_key=PRIVATE' } })
    return response('<html><title>404 Not Found</title>Sorry, unable to open the file at this time.</html>', { status: 404, contentType: 'text/html' })
  }
  let caught
  try { await connectAdminFinancialReports() } catch (error) { caught = error }
  assert.ok(caught)
  assert.match(caught.message, /non-JSON response/)
  assert.equal(caught.transport.http_status, 404)
  assert.equal(caught.transport.content_type, 'text/html')
  assert.equal(caught.transport.redirects, 1)
  assert.equal(caught.transport.page_hint, 'Google Drive cannot open the redirected web app response')
  assert.doesNotMatch(JSON.stringify(caught), /user_content_key=PRIVATE/)
  const diagnosis = diagnoseAdminFinancialReportsError(caught, {
    spreadsheetId: sheet,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${sheet}/edit`,
    secret,
  })
  assert.equal(diagnosis.diagnostic.code, 'APPS_SCRIPT_INVALID_RESPONSE')
  assert.equal(diagnosis.diagnostic.sheet_ids_match, true)
  assert.equal(diagnosis.diagnostic.transport.http_status, 404)
  assert.match(diagnosis.message, /redirects: 1/)
  assert.doesNotMatch(JSON.stringify(diagnosis), /PRIVATE|TEST_SECRET_NOT_FOR_PRODUCTION/)
})

test('Apps Script JSON rejection keeps its original reason for diagnosis', async () => {
  globalThis.fetch = async () => response(JSON.stringify({ ok: false, message: 'Unauthorized request' }))
  await assert.rejects(connectAdminFinancialReports(), (error) => {
    const diagnosis = diagnoseAdminFinancialReportsError(error, { secret })
    assert.equal(diagnosis.diagnostic.code, 'APPS_SCRIPT_SECRET_REJECTED')
    assert.equal(diagnosis.diagnostic.secret_status, 'Rejected by Apps Script')
    return true
  })
})

test('upsert writes only valid batches with no background retry', async () => {
  let calls = 0
  globalThis.fetch = async (url, options) => {
    calls += 1
    const body = JSON.parse(options.body)
    assert.equal(body.action, 'upsert_rows')
    assert.equal(body.rows.length, 1)
    return response(JSON.stringify({ ok: true, appended: 1 }))
  }
  assert.equal((await upsertAdminFinancialReportRows([{ transaction_key: 'test:1' }])).appended, 1)
  assert.deepEqual(await upsertAdminFinancialReportRows([]), { ok: true, appended: 0, updated: 0, skipped: 0 })
  assert.equal(calls, 1)
  assert.throws(() => upsertAdminFinancialReportRows(new Array(501).fill({})), /at most 500/)
  assert.equal(calls, 1)
})

test('non-JSON initial Google sign-in page remains distinguishable from a rejected secret', async () => {
  globalThis.fetch = async () => response('<html><title>Sign in - Google Accounts</title></html>', { status: 200, contentType: 'text/html' })
  let caught
  try { await connectAdminFinancialReports() } catch (error) { caught = error }
  const diagnosis = diagnoseAdminFinancialReportsError(caught, { secret, spreadsheetId: sheet })
  assert.equal(diagnosis.diagnostic.code, 'APPS_SCRIPT_INVALID_RESPONSE')
  assert.equal(diagnosis.diagnostic.secret_status, 'Not verified')
  assert.equal(diagnosis.diagnostic.transport.page_hint, 'Google sign-in page returned instead of JSON')
})
