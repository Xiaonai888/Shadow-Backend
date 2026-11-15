import test from 'node:test'
import assert from 'node:assert/strict'
import {
  adminFinancialConfiguredSheetUrl,
  validateAdminFinancialSheetLink,
} from '../services/adminFinancialReportsSheetLink.service.js'

const id = '1VzyAVRf8-JBoC5ECd3dnKqdeaxyNcHSJIUMUtM5mYFA'
const url = `https://docs.google.com/spreadsheets/d/${id}/edit`

test('valid configured link can connect', () => {
  assert.equal(validateAdminFinancialSheetLink(url, id), url)
})

test('link with query parameters is accepted', () => {
  assert.equal(validateAdminFinancialSheetLink(`${url}?gid=0`, id), url)
})

test('configured sheet id and full link both work', () => {
  assert.equal(adminFinancialConfiguredSheetUrl(id), url)
  assert.equal(adminFinancialConfiguredSheetUrl(`${url}?gid=0`), url)
})

test('rejects mismatching sheet', () => {
  const other = '1ABC123EXAMPLEWontMatchABCD123456789'
  assert.throws(() => validateAdminFinancialSheetLink(`https://docs.google.com/spreadsheets/d/${other}/edit`, id), (e) => e.statusCode === 400)
})

test('rejects an untrusted domain and HTTP', () => {
  assert.throws(() => validateAdminFinancialSheetLink(`https://evil.example/spreadsheets/d/${id}/edit`, id), /Invalid Google Sheets link/)
  assert.throws(() => validateAdminFinancialSheetLink(`http://docs.google.com/spreadsheets/d/${id}/edit`, id), /Invalid Google Sheets link/)
})

test('rejects missing link or configuration', () => {
  assert.throws(() => validateAdminFinancialSheetLink('', id), (e) => e.statusCode === 400)
  assert.throws(() => validateAdminFinancialSheetLink(url, ''), (e) => e.statusCode === 503)
})
