import test from 'node:test'
import assert from 'node:assert/strict'
import { diagnoseAdminFinancialReportsError } from '../services/adminFinancialReportsDiagnostics.service.js'

const sheetId = '1VzyAVRf8-JBoC5ECd3dnKqdeaxyNcHSJlUMUtM5mYFA'
const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit?gid=0`
const config = { spreadsheetId: sheetId, spreadsheetUrl, secret: 'high-entropy-example-only-1234567890', task: 'CONNECT' }

test('identifies a rejected secret and does not reveal its value', () => {
  const result = diagnoseAdminFinancialReportsError(new Error('Unauthorized request'), config)
  assert.equal(result.diagnostic.code, 'APPS_SCRIPT_SECRET_REJECTED')
  assert.equal(result.diagnostic.secret_status, 'Rejected by Apps Script')
  assert.equal(result.diagnostic.render_secret_length, config.secret.length)
  assert.ok(!JSON.stringify(result).includes(config.secret))
})

test('identifies an inaccessible spreadsheet after secret verification', () => {
  const result = diagnoseAdminFinancialReportsError(new Error(`Illegal spreadsheet id or key: ${sheetId}`), config)
  assert.equal(result.diagnostic.code, 'GOOGLE_SHEET_OPEN_FAILED')
  assert.equal(result.diagnostic.field, 'SHADOW_ADMIN_FINANCIAL_SHEET_ID')
  assert.equal(result.diagnostic.secret_status, 'Accepted by Apps Script')
  assert.equal(result.diagnostic.sheet_ids_match, true)
  assert.ok(result.message.includes('Render Sheet ID'))
  assert.ok(result.message.includes('Admin Link ID'))
})

test('shows actual mismatched sheet ids in the response', () => {
  const result = diagnoseAdminFinancialReportsError(new Error('This Google Sheet does not match SHADOW_ADMIN_FINANCIAL_SHEET_ID on Render'), {
    ...config,
    spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/1ABC123EXAMPLEWontMatchABCD123456789/edit',
    task: 'CONNECT',
  })
  assert.equal(result.diagnostic.code, 'ADMIN_SHEET_LINK_MISMATCH')
  assert.equal(result.diagnostic.sheet_ids_match, false)
  assert.equal(result.statusCode, 502)
})

test('identifies missing sheet permission', () => {
  const result = diagnoseAdminFinancialReportsError(new Error('You do not have permission to access the requested document'), config)
  assert.equal(result.diagnostic.code, 'GOOGLE_SHEET_PERMISSION_DENIED')
})

test('identifies unexpected HTML instead of Apps Script JSON', () => {
  const result = diagnoseAdminFinancialReportsError(new Error('Admin Financial Reports returned a non-JSON response'), config)
  assert.equal(result.diagnostic.code, 'APPS_SCRIPT_INVALID_RESPONSE')
})

test('rejects disclosing secrets in unknown errors', () => {
  const result = diagnoseAdminFinancialReportsError(new Error(`Something failed ${config.secret} in the request`), config)
  assert.equal(result.diagnostic.code, 'FINANCIAL_REPORTS_UNCLASSIFIED')
  assert.ok(!JSON.stringify(result).includes(config.secret))
})

test('preserves expected concurrency error status', () => {
  const error = new Error('Financial Reports is already processing another request')
  error.statusCode = 409
  const result = diagnoseAdminFinancialReportsError(error, config)
  assert.equal(result.statusCode, 409)
  assert.equal(result.diagnostic.code, 'FINANCIAL_REPORTS_BUSY')
})
