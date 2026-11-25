import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSupportImageInput, makeSupportImageKey, validateSupportImageKey, matchesSupportImageHeader, MAX_SUPPORT_IMAGE_BYTES } from '../src/services/supportChatImageInput.service.js'
import { signSupportImageUrl } from '../src/services/supportChatPrivateR2Signing.service.js'

const config = { accountId: 'testaccount', bucket: 'private-bucket', accessKeyId: 'test-key', secretAccessKey: 'test-secret' }
const now = new Date('2026-11-25T00:00:00Z')
const id = 'c5df098e-3657-4b5f-848f-d51894a091a9'
const key = makeSupportImageKey('temp', 'image/webp', id)
const media = makeSupportImageKey('media', 'image/webp', id)

test('allows only bounded image input', () => {
  assert.deepEqual(parseSupportImageInput({ mime_type: 'image/webp', file_size: 500 }), { mime: 'image/webp', size: 500, extension: 'webp' })
  for (const size of [0, 31, '100', 32.5, MAX_SUPPORT_IMAGE_BYTES + 1, Infinity]) assert.equal(parseSupportImageInput({ mime_type: 'image/webp', file_size: size }), null)
  for (const mime of ['image/svg+xml', 'text/html', 'constructor', '__proto__', null]) assert.equal(parseSupportImageInput({ mime_type: mime, file_size: 100 }), null)
})
test('separates temporary and final object keys', () => {
  assert.ok(validateSupportImageKey(key, 'temp', 'image/webp'))
  assert.ok(validateSupportImageKey(media, 'media'))
  assert.equal(validateSupportImageKey(key, 'media'), false)
  assert.equal(validateSupportImageKey(key, 'temp', 'image/png'), false)
  assert.equal(validateSupportImageKey('../' + key, 'temp'), false)
  assert.equal(validateSupportImageKey(key + '?x', 'temp'), false)
  assert.throws(() => makeSupportImageKey('temp', 'image/webp', '../file'))
})
test('recognizes image headers and rejects HTML', () => {
  const webp = Buffer.from('RIFF1234WEBPVP8 ')
  assert.ok(matchesSupportImageHeader(webp, 'image/webp'))
  assert.equal(matchesSupportImageHeader(webp, 'image/jpeg'), false)
  assert.equal(matchesSupportImageHeader(Buffer.from('<html>malicious payload</html>'), 'image/webp'), false)
  assert.ok(matchesSupportImageHeader(Buffer.from([255,216,255,...Array(13).fill(0)]), 'image/jpeg'))
  assert.ok(matchesSupportImageHeader(Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]), 'image/png'))
})
test('PUT signs exact content length and MIME with short expiry', () => {
  const a = new URL(signSupportImageUrl(config, { method: 'PUT', key, mime: 'image/webp', size: 100, now }))
  const b = new URL(signSupportImageUrl(config, { method: 'PUT', key, mime: 'image/webp', size: 101, now }))
  assert.equal(a.hostname, 'testaccount.r2.cloudflarestorage.com')
  assert.equal(a.searchParams.get('X-Amz-SignedHeaders'), 'content-length;content-type;host')
  assert.equal(a.searchParams.get('X-Amz-Expires'), '300')
  assert.match(a.searchParams.get('X-Amz-Signature'), /^[a-f0-9]{64}$/)
  assert.notEqual(a.searchParams.get('X-Amz-Signature'), b.searchParams.get('X-Amz-Signature'))
  assert.ok(!a.href.includes(config.secretAccessKey))
})
test('GET is short-lived and not cacheable', () => {
  const url = new URL(signSupportImageUrl(config, { method: 'GET', key: media, now }))
  assert.equal(url.searchParams.get('X-Amz-Expires'), '120')
  assert.equal(url.searchParams.get('response-cache-control'), 'private, no-store')
})
test('refuses access outside image operation scope', () => {
  assert.throws(() => signSupportImageUrl(config, { method: 'GET', key, now }))
  assert.throws(() => signSupportImageUrl(config, { method: 'PUT', key: media, mime: 'image/webp', size: 100, now }))
  assert.throws(() => signSupportImageUrl(config, { method: 'DELETE', key: media, now }))
  assert.throws(() => signSupportImageUrl(config, { method: 'PUT', key, mime: 'image/png', size: 100, now }))
  assert.throws(() => signSupportImageUrl({}, { method: 'GET', key: media, now }))
})
