import { createHash, timingSafeEqual } from 'node:crypto'

const API = String(process.env.SHADOW_BACKEND_URL || 'https://shadow-backend-kucw.onrender.com').replace(/\/+$/, '')
const QR_SOURCE = 'https://raw.githubusercontent.com/Xiaonai888/Web-React-2/main/public/assets/Icons/Picture/Binance%20QR.webp'
const EXPECTED_UID = '514018161'
const EXPECTED_NAME = 'Reaper Of Soul'
const results = []

function check(label, condition, detail = '') {
  results.push({ label, passed: Boolean(condition), detail })
}

async function get(url, accept = 'application/json') {
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: accept },
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(12000),
  })
  return response
}

async function probe(label, path, expectedStatus, expectedCode = '') {
  try {
    const response = await get(`${API}${path}`)
    const data = await response.json().catch(() => null)
    const valid = expectedStatus.includes(response.status) && (!expectedCode || data?.code === expectedCode)
    check(label, valid, `HTTP ${response.status}${data?.code ? ` / ${data.code}` : ''}`)
  } catch (error) {
    check(label, false, error?.name === 'TimeoutError' ? 'Timed out' : 'Endpoint unreachable')
  }
}

async function main() {
  const enabled = String(process.env.BINANCE_PAYMENT_ENABLED || '').trim()
  const uid = String(process.env.BINANCE_RECEIVER_UID || '').trim()
  const name = String(process.env.BINANCE_RECEIVER_NAME || '').trim()
  const hash = String(process.env.BINANCE_QR_SHA256 || '').trim().toLowerCase()
  check('Live payment switch remains disabled', enabled !== 'true')
  check('Official receiver UID configured', uid === EXPECTED_UID)
  check('Official receiver name configured', name === EXPECTED_NAME)
  check('Expected QR SHA-256 configured', /^[0-9a-f]{64}$/.test(hash))

  try {
    const response = await get(QR_SOURCE, 'image/webp')
    const bytes = Buffer.from(await response.arrayBuffer())
    const format = bytes.length >= 16 && bytes.length <= 512 * 1024
      && bytes.toString('ascii', 0, 4) === 'RIFF'
      && bytes.toString('ascii', 8, 12) === 'WEBP'
    check('Official QR accessible and valid WebP', response.status === 200 && format)
    const actual = createHash('sha256').update(bytes).digest()
    const expected = /^[0-9a-f]{64}$/.test(hash) ? Buffer.from(hash, 'hex') : Buffer.alloc(32)
    check('Official QR matches pinned SHA-256', format && timingSafeEqual(actual, expected))
  } catch {
    check('Official QR accessible and valid WebP', false, 'GitHub QR fetch failed')
    check('Official QR matches pinned SHA-256', false, 'Cannot verify QR')
  }

  await probe('Disabled receiver endpoint rejects QR access', '/api/purchase/binance/receiver', [503], 'BINANCE_RECEIVER_UNAVAILABLE')
  await probe('Disabled QR endpoint rejects download', '/api/purchase/binance/receiver/qr', [503], 'BINANCE_RECEIVER_UNAVAILABLE')
  await probe('Reader order requires authentication', '/api/purchase/binance/checkout/00000000-0000-4000-8000-000000000001', [401, 403])
  await probe('Admin review requires authentication', '/api/admin/purchases/binance/checkout-reviews', [401, 403])

  for (const result of results) {
    console.log(`${result.passed ? 'PASS' : 'FAIL'} | ${result.label}${result.detail ? ` | ${result.detail}` : ''}`)
  }
  const passed = results.filter(item => item.passed).length
  console.log(`FINAL: ${passed}/${results.length} checks passed`)
  console.log('Read-only: no payments, orders, wallet changes, or database writes')
  if (passed !== results.length) process.exitCode = 1
}

await main()
