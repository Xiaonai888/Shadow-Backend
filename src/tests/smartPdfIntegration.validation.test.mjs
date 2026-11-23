import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const load = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const server = load('../../server.js')
const routes = load('../routes/smartPdf.routes.js')
const controller = load('../controllers/smartPdf.controller.js')
const checkout = load('../services/discoverAuthorStoreCheckoutPricing.service.js')
const authorStore = load('../controllers/authorStore.controller.js')
const exposureMigration = load('../../sql/20261123_smart_pdf_exposure.sql')
const verification = load('../../sql/20261123_smart_pdf_exposure_verify.sql')
const candidateReport = load('../../sql/20261123_smart_pdf_eligible_candidates_verify.sql')

test('server imports the existing Smart PDF router', () => {
  assert.match(server, /import\s+smartPdfRoutes\s+from\s+['"]\.\/src\/routes\/smartPdf\.routes\.js['"]/) 
})

test('server mounts the Smart PDF route exactly once after JSON parser', () => {
  const mounts = [...server.matchAll(/app\.use\(\s*['"]\/api\/smart-pdf['"]\s*,\s*smartPdfRoutes\s*\)/g)]
  assert.equal(mounts.length, 1)
  assert.ok(server.indexOf("app.use(express.json(") < mounts[0].index)
})

test('Smart PDF routes expose version, selection and tracked events', () => {
  assert.match(routes, /router\.get\(\s*['"]\/version['"]/) 
  assert.match(routes, /router\.post\(\s*['"]\/select['"]/) 
  assert.match(routes, /router\.post\(\s*['"]\/events['"]/) 
  assert.match(routes, /verifyReaderSessionIfPresent/) 
})

test('selection signs personalized PDF offers at the API boundary', () => {
  assert.match(controller, /attachSmartPdfOfferTokens\(result,\s*\{/) 
  assert.match(controller, /readerId:\s*readerIdentity\.readerId/) 
  assert.match(controller, /placement/) 
})

test('checkout recognizes tokens while preserving legacy promotions', () => {
  assert.match(checkout, /hasSmartPdfOfferMarker/) 
  assert.match(checkout, /applySmartPdfOfferCheckout\(requested,\s*orderItem,\s*\{\s*readerId\s*\}\)/) 
  assert.match(checkout, /getCurrentDiscoverAuthorStorePromotions/) 
  assert.match(checkout, /getCurrentDiscoverPdfPromotionsForLanguage/) 
})

test('ABA and Binance payment calls both bind checkout to the signed-in reader', () => {
  const calls = [...authorStore.matchAll(/applyDiscoverAuthorStoreCheckoutPrices\([^\n]+\{\s*readerId:\s*userId\s*\}\)/g)]
  assert.equal(calls.length, 2)
})

test('Binance PDF error handler defines code before using code.includes', () => {
  const start = authorStore.indexOf('function publicBinancePdfError(')
  const end = authorStore.indexOf('export async function createAuthorStoreBinancePdfCheckout(', start)
  assert.ok(start >= 0 && end > start)
  const handler = authorStore.slice(start, end)
  assert.match(handler, /const\s+code\s*=\s*String\(err\?\.code\s*\|\|\s*err\?\.message\s*\|\|\s*['"]['"]\)/)
  assert.ok(handler.indexOf('const code =') < handler.indexOf('code.includes('))
  assert.match(handler, /SMART_PDF_PROMOTION_INVALID/)
})

test('exposure migration contains required secure tables and restricted RPC', () => {
  assert.match(exposureMigration, /CREATE TABLE IF NOT EXISTS public\.smart_pdf_reader_exposure/) 
  assert.match(exposureMigration, /CREATE TABLE IF NOT EXISTS public\.smart_pdf_product_exposure_totals/) 
  assert.match(exposureMigration, /CREATE OR REPLACE FUNCTION public\.smart_pdf_record_events_v1/) 
  assert.match(exposureMigration, /REVOKE ALL ON FUNCTION public\.smart_pdf_record_events_v1/) 
  assert.match(exposureMigration, /GRANT EXECUTE ON FUNCTION public\.smart_pdf_record_events_v1[^\n]*TO service_role/) 
})

test('verification SQL is read-only and checks RLS and role privileges', () => {
  assert.match(verification, /reader_table_rls/) 
  assert.match(verification, /record_service_role_allowed/) 
  assert.match(verification, /record_anon_execute_denied/) 
  assert.doesNotMatch(verification, /^\s*(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE|GRANT|REVOKE)\b/im)
})

test('candidate report is read-only and counts eligibility by story language', () => {
  assert.match(candidateReport, /eligible_for_smart_pdf/) 
  assert.match(candidateReport, /discount_below_20_percent/) 
  assert.match(candidateReport, /GROUP BY language, result/) 
  assert.doesNotMatch(candidateReport, /^\s*(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE|GRANT|REVOKE)\b/im)
})
